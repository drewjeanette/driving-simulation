import * as THREE from 'three';
import { feature } from 'topojson-client';
import type { Topology, GeometryCollection } from 'topojson-specification';
import type { MultiPolygon, Polygon, Position } from 'geojson';
import { LatLng, clamp, toDeg, toRad } from '../geo/geo';

const RADIUS = 1;

function toVec(p: LatLng, r = RADIUS): THREE.Vector3 {
  const lat = toRad(p.lat);
  const lng = toRad(p.lng);
  return new THREE.Vector3(
    Math.cos(lat) * Math.sin(lng) * r,
    Math.sin(lat) * r,
    Math.cos(lat) * Math.cos(lng) * r,
  );
}

function toLatLng(v: THREE.Vector3): LatLng {
  const n = v.clone().normalize();
  return { lat: toDeg(Math.asin(n.y)), lng: toDeg(Math.atan2(n.x, n.z)) };
}

/** Draws land polygons into an equirectangular mask so dots can test "is this land?". */
async function landMask(width: number, height: number): Promise<Uint8ClampedArray> {
  const topo = (await import('world-atlas/land-110m.json')).default as unknown as Topology<{
    land: GeometryCollection;
  }>;
  const land = feature(topo, topo.objects.land);
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.fillStyle = '#fff';
  const ring = (coords: Position[]) => {
    coords.forEach(([lng, lat], i) => {
      const x = ((lng + 180) / 360) * width;
      const y = ((90 - lat) / 180) * height;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    });
    g.closePath();
  };
  const features = 'features' in land ? land.features : [land];
  for (const f of features) {
    const geom = f.geometry as Polygon | MultiPolygon;
    const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
    for (const poly of polys) {
      g.beginPath();
      poly.forEach(ring);
      g.fill('evenodd');
    }
  }
  return g.getImageData(0, 0, width, height).data;
}

/**
 * The landing-page globe: a dotted Earth you can spin, plus a click-to-pick
 * location marker. Pure three.js with Natural Earth land outlines, so it
 * needs no map provider or API key.
 */
export class Globe {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
  private readonly earth = new THREE.Group();
  private readonly pin: THREE.Group;
  private readonly ro: ResizeObserver;
  private rotX = 0.35;
  private rotY = -1.6;
  private velX = 0;
  private velY = 0.0009;
  private targetRot: { x: number; y: number } | null = null;
  private dragging = false;
  private moved = 0;
  private last = { x: 0, y: 0 };
  private disposed = false;
  onPick?: (p: LatLng) => void;

  constructor(private readonly host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.domElement.className = 'globe-canvas';
    this.renderer.domElement.setAttribute(
      'aria-label',
      'Interactive globe. Drag to spin, click to choose a starting point.',
    );
    this.renderer.domElement.setAttribute('role', 'img');
    host.append(this.renderer.domElement);
    this.camera.position.set(0, 0, 4.2);

    const ocean = new THREE.Mesh(
      new THREE.SphereGeometry(RADIUS * 0.995, 64, 48),
      new THREE.MeshBasicMaterial({ color: '#0b1730' }),
    );
    this.earth.add(ocean);

    // Atmosphere: a back-facing rim glow.
    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(RADIUS * 1.18, 64, 48),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        transparent: true,
        depthWrite: false,
        vertexShader: `varying vec3 vN; void main(){ vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: `varying vec3 vN; void main(){ float i = pow(0.72 - dot(vN, vec3(0.0,0.0,1.0)), 3.0); gl_FragColor = vec4(0.25,0.55,1.0,1.0) * i; }`,
      }),
    );
    this.scene.add(glow);

    this.pin = new THREE.Group();
    const stem = new THREE.Mesh(
      new THREE.CylinderGeometry(0.004, 0.004, 0.12, 8).translate(0, 0.06, 0),
      new THREE.MeshBasicMaterial({ color: '#fbbf24' }),
    );
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.022, 16, 12).translate(0, 0.12, 0),
      new THREE.MeshBasicMaterial({ color: '#fbbf24' }),
    );
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.03, 0.045, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        color: '#fbbf24',
        transparent: true,
        opacity: 0.8,
        side: THREE.DoubleSide,
      }),
    );
    ring.name = 'ring';
    this.pin.add(stem, head, ring);
    this.pin.visible = false;
    this.earth.add(this.pin);

    this.scene.add(this.earth);
    void this.buildDots();

    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
    this.renderer.setAnimationLoop(this.frame);
  }

  private async buildDots(): Promise<void> {
    const W = 1024;
    const H = 512;
    const mask = await landMask(W, H);
    if (this.disposed) return;
    const N = 26000;
    const positions: number[] = [];
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < N; i++) {
      const y = 1 - (i / (N - 1)) * 2;
      const r = Math.sqrt(1 - y * y);
      const theta = golden * i;
      const v = new THREE.Vector3(Math.cos(theta) * r, y, Math.sin(theta) * r);
      const ll = toLatLng(v);
      const px = clamp(Math.floor(((ll.lng + 180) / 360) * W), 0, W - 1);
      const py = clamp(Math.floor(((90 - ll.lat) / 180) * H), 0, H - 1);
      if (mask[(py * W + px) * 4] > 128) positions.push(v.x, v.y, v.z);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { size: { value: 3.2 * this.renderer.getPixelRatio() } },
      vertexShader: `
        uniform float size;
        varying float vFacing;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vFacing = dot(normalize(normalMatrix * position), vec3(0.0, 0.0, 1.0));
          gl_PointSize = size;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying float vFacing;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          if (dot(c, c) > 0.25) discard;
          float a = smoothstep(-0.1, 0.35, vFacing);
          vec3 col = mix(vec3(0.35, 0.62, 1.0), vec3(0.75, 0.88, 1.0), smoothstep(0.3, 1.0, vFacing));
          gl_FragColor = vec4(col, a);
        }`,
    });
    this.earth.add(new THREE.Points(geo, mat));
  }

  /** Spins the globe to face a location and drops the pin there. */
  focus(p: LatLng, showPin = true): void {
    this.targetRot = { x: toRad(p.lat), y: -toRad(p.lng) };
    this.velY = 0;
    if (showPin) this.setPin(p);
  }

  setPin(p: LatLng | null): void {
    this.pin.visible = !!p;
    if (!p) return;
    const v = toVec(p);
    this.pin.position.copy(v);
    this.pin.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), v.clone().normalize());
  }

  private onDown = (e: PointerEvent) => {
    this.dragging = true;
    this.moved = 0;
    this.last = { x: e.clientX, y: e.clientY };
    this.targetRot = null;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  private onMove = (e: PointerEvent) => {
    if (!this.dragging) return;
    const dx = e.clientX - this.last.x;
    const dy = e.clientY - this.last.y;
    this.moved += Math.abs(dx) + Math.abs(dy);
    this.last = { x: e.clientX, y: e.clientY };
    const k = 0.005 * (this.camera.position.z / 4.2);
    this.velY = dx * k;
    this.velX = dy * k;
    this.rotY += dx * k;
    this.rotX = clamp(this.rotX + dy * k, -1.3, 1.3);
  };

  private onUp = (e: PointerEvent) => {
    if (!this.dragging) return;
    this.dragging = false;
    if (this.moved < 6) this.pick(e);
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.camera.position.z = clamp(this.camera.position.z + e.deltaY * 0.002, 2.1, 6);
  };

  private pick(e: PointerEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hit = ray.ray.intersectSphere(
      new THREE.Sphere(new THREE.Vector3(), RADIUS),
      new THREE.Vector3(),
    );
    if (!hit) return;
    const local = this.earth.worldToLocal(hit.clone());
    const p = toLatLng(local);
    this.setPin(p);
    this.velY = 0;
    this.onPick?.(p);
  }

  private frame = (time: number) => {
    if (this.targetRot) {
      // Ease toward the target, taking the short way around.
      let dy = this.targetRot.y - this.rotY;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      this.rotY += dy * 0.08;
      this.rotX += (this.targetRot.x - this.rotX) * 0.08;
      if (Math.abs(dy) < 1e-3 && Math.abs(this.targetRot.x - this.rotX) < 1e-3)
        this.targetRot = null;
    } else if (!this.dragging) {
      this.rotY += this.velY;
      this.rotX = clamp(this.rotX + this.velX, -1.3, 1.3);
      this.velX *= 0.94;
      this.velY = this.velY * 0.95 + (this.pin.visible ? 0 : 0.0009) * 0.05;
    }
    this.earth.rotation.set(this.rotX, this.rotY, 0, 'XYZ');
    const ring = this.pin.getObjectByName('ring');
    if (ring) {
      const k = 1 + ((time / 900) % 1) * 1.6;
      ring.scale.set(k, k, k);
      ((ring as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity =
        0.9 * (1 - ((time / 900) % 1));
    }
    this.renderer.render(this.scene, this.camera);
  };

  private resize(): void {
    const w = this.host.clientWidth || 1;
    const h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.ro.disconnect();
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Points) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
