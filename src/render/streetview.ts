import * as THREE from 'three';
import { DrivePath } from '../geo/path';
import { Vec2, clamp, toRad } from '../geo/geo';
import { PanoMetadata, StreetViewTiles, tileGrid } from '../providers/google/streetview';

/** Height of the Street View camera above the road, metres. */
const PANO_HEIGHT = 2.5;
/** Radius of the cylinder used as a stand-in for building facades. */
const FACADE_RADIUS = 14;
const DISCOVERY_SPACING = 10; // metres between pano lookups along the route
const LOOKAHEAD = 900; // metres of route to discover ahead of the car
const MAX_TEXTURES = 18;

export type StreetViewQuality = 'low' | 'high' | 'ultra';

interface Pano {
  id: string;
  meta: PanoMetadata;
  pos: Vec2;
  s: number;
  zoom: number;
  texture: THREE.Texture | null;
  loading: boolean;
  lastUsed: number;
}

/**
 * Renders Google Street View imagery around the car with smooth motion.
 *
 * Each panorama is a photo taken from a single point. Instead of jumping from
 * photo to photo, the shader projects each photo onto a simple proxy of the
 * street (a ground plane plus a cylinder standing in for building fronts) and
 * views that proxy from the car's true, continuously moving position. Two
 * neighbouring panoramas are projected at once and cross-faded, so the road
 * flows under the car the way it does in a real vehicle. Because it is plain
 * geometry in the scene, the same view works per-eye in a VR headset.
 */
export class StreetViewLayer {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly panos: Pano[] = [];
  private readonly known = new Set<string>();
  private discoveredUntil = 0;
  private discovering = false;
  private metaQueue: string[] = [];
  private metaInFlight = 0;
  private texturesInFlight = 0;
  private disposed = false;
  private failures = 0;
  quality: StreetViewQuality = 'high';
  /** Largest texture the GPU accepts; 'ultra' needs 8192 for full-resolution panoramas. */
  maxTextureSize = 4096;
  /** 0..1, how much of the view Street View currently covers. */
  coverage = 0;
  /** Copyright line of the panorama nearest the car. */
  attribution = '';
  onError?: (message: string) => void;

  constructor(
    private readonly tiles: StreetViewTiles,
    private readonly path: DrivePath,
  ) {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        texA: { value: null },
        texB: { value: null },
        centerA: { value: new THREE.Vector3() },
        centerB: { value: new THREE.Vector3() },
        headingA: { value: 0 },
        headingB: { value: 0 },
        blend: { value: 0 },
        opacity: { value: 0 },
        facadeRadius: { value: FACADE_RADIUS },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      side: THREE.BackSide,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(800, 48, 24), this.material);
    this.mesh.name = 'street-view';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
  }

  /** Call once per frame with the car's distance along the route and world position. */
  update(s: number, carPos: THREE.Vector3, dt: number): void {
    this.mesh.position.copy(carPos);
    this.discover(s);
    this.pumpMetadata();
    this.pumpTextures(s);

    const ready = this.panos.filter((p) => p.texture);
    let a: Pano | null = null;
    let b: Pano | null = null;
    for (const p of ready) {
      if (p.s <= s && (!a || p.s > a.s)) a = p;
      if (p.s > s && (!b || p.s < b.s)) b = p;
    }
    // Panoramas far from the car would project badly; treat them as absent.
    if (a && s - a.s > 30) a = null;
    if (b && b.s - s > 30) b = null;
    const first = a ?? b;
    const second = b ?? a;
    let target = 0;
    if (first && second) {
      const span = second.s - first.s;
      const t = span > 0.01 ? clamp((s - first.s) / span, 0, 1) : 0;
      // Ease the cross-fade so each photo is crisp near its own position.
      const blend = t * t * (3 - 2 * t);
      const u = this.material.uniforms;
      u.texA.value = first.texture;
      u.texB.value = second.texture;
      u.centerA.value.set(first.pos.x, PANO_HEIGHT, -first.pos.y);
      u.centerB.value.set(second.pos.x, PANO_HEIGHT, -second.pos.y);
      u.headingA.value = toRad(first.meta.heading);
      u.headingB.value = toRad(second.meta.heading);
      u.blend.value = blend;
      first.lastUsed = second.lastUsed = performance.now();
      target = 1;
      const nearest = blend < 0.5 ? first : second;
      this.attribution = [nearest.meta.copyright, nearest.meta.date].filter(Boolean).join(' · ');
    }
    this.coverage += (target - this.coverage) * clamp(dt * 4, 0, 1);
    this.material.uniforms.opacity.value = this.coverage;
    this.mesh.visible = this.coverage > 0.01;
  }

  private discover(s: number): void {
    if (this.discovering || this.disposed || this.failures > 3) return;
    if (this.discoveredUntil >= this.path.length || this.discoveredUntil > s + LOOKAHEAD) return;
    this.discovering = true;
    const start = this.discoveredUntil;
    const locations = [];
    for (let i = 0; i < 100; i++) {
      const at = start + i * DISCOVERY_SPACING;
      if (at > this.path.length) break;
      locations.push(this.path.toLatLng(this.path.sample(at)));
    }
    this.tiles
      .panoIds(locations, 20)
      .then((ids) => {
        for (const id of ids) {
          if (id && !this.known.has(id)) {
            this.known.add(id);
            this.metaQueue.push(id);
          }
        }
        this.discoveredUntil = start + locations.length * DISCOVERY_SPACING;
        this.failures = 0;
      })
      .catch((err: Error) => this.fail(err))
      .finally(() => (this.discovering = false));
  }

  private pumpMetadata(): void {
    while (this.metaInFlight < 4 && this.metaQueue.length && !this.disposed) {
      const id = this.metaQueue.shift()!;
      this.metaInFlight++;
      this.tiles
        .metadata(id)
        .then((meta) => {
          const pos = this.path.projection.toLocal({ lat: meta.lat, lng: meta.lng });
          const hit = this.path.project(pos);
          // Skip panoramas that belong to a different road (e.g. an overpass).
          if (hit.distance > 12) return;
          this.panos.push({
            id,
            meta,
            pos,
            s: hit.s,
            zoom: 0,
            texture: null,
            loading: false,
            lastUsed: 0,
          });
          this.panos.sort((x, y) => x.s - y.s);
        })
        .catch((err: Error) => this.fail(err))
        .finally(() => this.metaInFlight--);
    }
  }

  private pumpTextures(s: number): void {
    const near = this.panos
      .filter((p) => p.s > s - 25 && p.s < s + 140)
      .sort((x, y) => Math.abs(x.s - s - 10) - Math.abs(y.s - s - 10));
    for (const p of near) {
      if (this.texturesInFlight >= 3) break;
      if (p.loading) continue;
      const d = Math.abs(p.s - s);
      // Progressive sharpness: every pano starts at zoom 2 (2K), the ones around
      // the car upgrade to 4K, and on 'ultra' the very nearest go to 8K.
      let want = 2;
      if (this.quality !== 'low' && d < 35) want = 3;
      if (this.quality === 'ultra' && d < 15 && this.maxTextureSize >= 8192) want = 4;
      if (p.zoom >= want) continue;
      void this.loadTexture(p, p.zoom === 0 ? 2 : want);
    }
    this.evict(s);
  }

  private async loadTexture(p: Pano, z: number): Promise<void> {
    p.loading = true;
    this.texturesInFlight++;
    try {
      const grid = tileGrid(p.meta, z);
      const canvas = document.createElement('canvas');
      canvas.width = Math.min(grid.width, this.maxTextureSize);
      canvas.height = Math.min(grid.height, this.maxTextureSize / 2);
      const ctx = canvas.getContext('2d')!;
      const sx = canvas.width / grid.width;
      const sy = canvas.height / grid.height;
      const jobs: Promise<void>[] = [];
      for (let y = 0; y < grid.rows; y++) {
        for (let x = 0; x < grid.cols; x++) {
          jobs.push(
            this.tiles
              .tileUrl(p.id, z, x, y)
              .then(loadImage)
              .then((img) => {
                ctx.drawImage(
                  img,
                  x * grid.tileWidth * sx,
                  y * grid.tileHeight * sy,
                  grid.tileWidth * sx,
                  grid.tileHeight * sy,
                );
              }),
          );
        }
      }
      await Promise.all(jobs);
      if (this.disposed) return;
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.generateMipmaps = false; // avoids a seam where the panorama wraps around
      tex.minFilter = THREE.LinearFilter;
      tex.wrapS = THREE.RepeatWrapping;
      p.texture?.dispose();
      p.texture = tex;
      p.zoom = z;
      p.lastUsed = performance.now();
    } catch (err) {
      this.fail(err as Error);
    } finally {
      p.loading = false;
      this.texturesInFlight--;
    }
  }

  private evict(s: number): void {
    const loaded = this.panos.filter((p) => p.texture);
    if (loaded.length <= MAX_TEXTURES) return;
    loaded
      .sort((x, y) => Math.abs(y.s - s) - Math.abs(x.s - s))
      .slice(0, loaded.length - MAX_TEXTURES)
      .forEach((p) => {
        p.texture?.dispose();
        p.texture = null;
        p.zoom = 0;
      });
  }

  private fail(err: Error): void {
    this.failures++;
    console.warn('Street View:', err.message);
    if (this.failures === 3) {
      this.onError?.(
        'Street View imagery is unavailable (the Map Tiles API may not be enabled for this key). Showing the simulated road instead.',
      );
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const p of this.panos) p.texture?.dispose();
    this.material.dispose();
    this.mesh.geometry.dispose();
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.referrerPolicy = 'strict-origin-when-cross-origin';
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Street View tile failed to load'));
    img.src = url;
  });
}

const VERTEX = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

const FRAGMENT = /* glsl */ `
  uniform sampler2D texA;
  uniform sampler2D texB;
  uniform vec3 centerA;
  uniform vec3 centerB;
  uniform float headingA;
  uniform float headingB;
  uniform float blend;
  uniform float opacity;
  uniform float facadeRadius;
  varying vec3 vWorld;

  const float PI = 3.14159265359;

  // Where does the view ray from the eye hit the street proxy around a pano?
  vec3 proxyHit(vec3 origin, vec3 dir, vec3 center) {
    float t = 1e4;
    if (dir.y < -1e-4) t = min(t, -origin.y / dir.y); // road surface at y = 0
    vec2 o = origin.xz - center.xz;
    vec2 d = dir.xz;
    float a = dot(d, d);
    if (a > 1e-6) {
      float b = dot(o, d);
      float c = dot(o, o) - facadeRadius * facadeRadius;
      float disc = b * b - a * c;
      if (disc > 0.0) t = min(t, (-b + sqrt(disc)) / a);
    }
    return origin + dir * t;
  }

  vec4 samplePano(sampler2D tex, vec3 center, float heading, vec3 origin, vec3 dir) {
    vec3 p = normalize(proxyHit(origin, dir, center) - center);
    float azimuth = atan(p.x, -p.z); // compass: 0 = north (-z), clockwise
    float u = fract(0.5 + (azimuth - heading) / (2.0 * PI));
    float v = 0.5 + asin(clamp(p.y, -1.0, 1.0)) / PI;
    return texture2D(tex, vec2(u, v));
  }

  void main() {
    vec3 dir = normalize(vWorld - cameraPosition);
    vec4 a = samplePano(texA, centerA, headingA, cameraPosition, dir);
    vec4 b = samplePano(texB, centerB, headingB, cameraPosition, dir);
    gl_FragColor = vec4(mix(a.rgb, b.rgb, blend), opacity);
    #include <colorspace_fragment>
  }
`;
