import * as THREE from 'three';
import { DrivePath } from '../geo/path';
import { Vec2, clamp, toRad } from '../geo/geo';
import { ImageryQuality, PanoInfo, PanoSource } from '../providers/imagery';

/** Radius of the cylinder used as a stand-in for building facades. */
const FACADE_RADIUS = 14;
/** Hard cap on GPU textures; most of the buffer is held at low resolution. */
const MAX_TEXTURES = 70;
const DISCOVERY_CHUNK = 600; // metres of route looked up per discovery request

export type StreetViewQuality = ImageryQuality;

export interface LoadWindow {
  /** Metres of road to keep loaded in the direction of travel. */
  ahead: number;
  /** Metres to keep behind the car. */
  behind: number;
  /** +1 driving forward along the route, -1 reversing. */
  direction: 1 | -1;
}

/**
 * Like a game's render distance, but stretched along the road: the faster
 * you go, the further ahead imagery is preloaded (about 8 seconds of
 * travel), while only a short tail is kept behind. Reversing flips it.
 */
export function loadWindow(speed: number): LoadWindow {
  const v = Math.abs(speed);
  return {
    ahead: clamp(60 + v * 8, 60, 450),
    behind: clamp(25 + v * 1.5, 25, 70),
    direction: speed < -0.5 ? -1 : 1,
  };
}

interface Pano {
  info: PanoInfo;
  pos: Vec2;
  s: number;
  level: number;
  texture: THREE.Texture | null;
  loading: boolean;
}

/**
 * Renders 360° street imagery (Google Street View or Mapillary) around the
 * car with smooth motion.
 *
 * Each panorama is a photo taken from a single point. Instead of jumping from
 * photo to photo, the shader projects each photo onto a simple proxy of the
 * street (a ground plane plus a cylinder standing in for building fronts) and
 * views that proxy from the car's true, continuously moving position. Two
 * neighbouring panoramas are projected at once and cross-faded, so the road
 * flows under the car the way it does in a real vehicle. Because it is plain
 * geometry in the scene, the same view works per-eye in a VR headset.
 *
 * Loading works like chunked render distance: a speed-dependent window of
 * road ahead is kept loaded, at full resolution near the car and lower
 * resolution further out, so photos are ready before the car reaches them.
 */
export class StreetViewLayer {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly panos: Pano[] = [];
  private readonly known = new Set<string>();
  private discoveredUntil = 0;
  private discovering = false;
  private texturesInFlight = 0;
  private disposed = false;
  private failures = 0;
  quality: StreetViewQuality = 'high';
  /** Largest texture the GPU accepts. */
  maxTextureSize = 4096;
  /** 0..1, how much of the view the imagery currently covers. */
  coverage = 0;
  /** Credit line for the panorama nearest the car. */
  attribution = '';
  /** Metres of road ahead with imagery loaded and ready, for the HUD. */
  bufferedAhead = 0;
  window: LoadWindow = loadWindow(0);
  onError?: (message: string) => void;

  constructor(
    readonly source: PanoSource,
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

  /** Call once per frame with the car's route distance, eye position and speed. */
  update(s: number, carPos: THREE.Vector3, dt: number, speed = 0): void {
    this.mesh.position.copy(carPos);
    this.window = loadWindow(speed);
    this.discover(s);
    this.pumpTextures(s);
    this.bufferedAhead = this.measureBuffer(s);

    let a: Pano | null = null;
    let b: Pano | null = null;
    for (const p of this.panos) {
      if (!p.texture) continue;
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
      u.centerA.value.set(first.pos.x, first.info.height, -first.pos.y);
      u.centerB.value.set(second.pos.x, second.info.height, -second.pos.y);
      u.headingA.value = toRad(first.info.heading);
      u.headingB.value = toRad(second.info.heading);
      u.blend.value = blend;
      target = 1;
      this.attribution = (blend < 0.5 ? first : second).info.attribution;
    }
    this.coverage += (target - this.coverage) * clamp(dt * 4, 0, 1);
    this.material.uniforms.opacity.value = this.coverage;
    this.mesh.visible = this.coverage > 0.01;
  }

  /** Looks up which panoramas exist well beyond the load window. */
  private discover(s: number): void {
    if (this.discovering || this.disposed || this.failures > 3) return;
    const horizon = s + this.window.ahead + DISCOVERY_CHUNK;
    if (this.discoveredUntil >= this.path.length || this.discoveredUntil > horizon) return;
    this.discovering = true;
    const from = this.discoveredUntil;
    const to = Math.min(from + DISCOVERY_CHUNK, this.path.length);
    this.source
      .discover(this.path, from, to)
      .then((found) => {
        for (const info of found) {
          if (this.known.has(info.id)) continue;
          this.known.add(info.id);
          const pos = this.path.projection.toLocal({ lat: info.lat, lng: info.lng });
          const hit = this.path.project(pos);
          // Skip panoramas that belong to a different road (e.g. an overpass).
          if (hit.distance > 12) continue;
          this.panos.push({ info, pos, s: hit.s, level: 0, texture: null, loading: false });
        }
        this.panos.sort((x, y) => x.s - y.s);
        this.discoveredUntil = to;
        this.failures = 0;
      })
      .catch((err: Error) => this.fail(err))
      .finally(() => (this.discovering = false));
  }

  /** Signed distance of a pano from the car, positive in the direction of travel. */
  private along(p: Pano, s: number): number {
    return (p.s - s) * this.window.direction;
  }

  private pumpTextures(s: number): void {
    const { ahead, behind } = this.window;
    const inWindow = this.panos.filter((p) => {
      const d = this.along(p, s);
      return d > -behind && d < ahead;
    });
    // Nearest first, with a bias toward what's coming up.
    inWindow.sort((x, y) => priority(this.along(x, s)) - priority(this.along(y, s)));
    for (const p of inWindow) {
      if (this.texturesInFlight >= 4) break;
      if (p.loading) continue;
      const d = Math.abs(p.s - s);
      // Level of detail rings: sharpest near the car, cheaper further out.
      const want =
        d < 35
          ? this.source.wantLevel(this.quality, d, this.maxTextureSize)
          : d < 150
            ? this.source.firstLevel(this.quality)
            : 1;
      if (p.level >= want) continue;
      // Get something on screen fast, then refine.
      void this.loadTexture(
        p,
        p.level === 0 ? Math.min(want, this.source.firstLevel(this.quality)) : want,
      );
    }
    this.evict(s);
  }

  private async loadTexture(p: Pano, level: number): Promise<void> {
    p.loading = true;
    this.texturesInFlight++;
    try {
      const canvas = await this.source.load(p.info, level, this.maxTextureSize);
      if (this.disposed) return;
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.generateMipmaps = false; // avoids a seam where the panorama wraps around
      tex.minFilter = THREE.LinearFilter;
      tex.wrapS = THREE.RepeatWrapping;
      p.texture?.dispose();
      p.texture = tex;
      p.level = level;
    } catch (err) {
      this.fail(err as Error);
    } finally {
      p.loading = false;
      this.texturesInFlight--;
    }
  }

  /** Unloads panoramas that fell out of the window, then the furthest if over budget. */
  private evict(s: number): void {
    const { ahead, behind } = this.window;
    const loaded = this.panos.filter((p) => p.texture);
    for (const p of loaded) {
      const d = this.along(p, s);
      if (d < -behind - 20 || d > ahead + 150) this.drop(p);
    }
    const still = loaded.filter((p) => p.texture);
    if (still.length <= MAX_TEXTURES) return;
    still
      .sort((x, y) => Math.abs(y.s - s) - Math.abs(x.s - s))
      .slice(0, still.length - MAX_TEXTURES)
      .forEach((p) => this.drop(p));
  }

  private drop(p: Pano): void {
    p.texture?.dispose();
    p.texture = null;
    p.level = 0;
  }

  /** How far ahead the run of loaded panoramas reaches without a gap. */
  private measureBuffer(s: number): number {
    const dir = this.window.direction;
    const ahead = this.panos
      .filter((p) => this.along(p, s) >= 0)
      .sort((x, y) => this.along(x, s) - this.along(y, s));
    let reach = 0;
    for (const p of ahead) {
      const d = (p.s - s) * dir;
      if (!p.texture || d - reach > 30) break;
      reach = d;
    }
    return reach;
  }

  private fail(err: Error): void {
    this.failures++;
    console.warn(`${this.source.name}:`, err.message);
    if (this.failures === 3) this.onError?.(this.source.unavailableMessage);
  }

  dispose(): void {
    this.disposed = true;
    for (const p of this.panos) p.texture?.dispose();
    this.material.dispose();
    this.mesh.geometry.dispose();
  }
}

/** Load order: what's just ahead first, then just behind, then further ahead. */
export function priority(along: number): number {
  return along >= 0 ? along : -along * 3;
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
