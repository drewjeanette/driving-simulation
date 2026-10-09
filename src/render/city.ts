import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { LocalProjection, Vec2 } from '../geo/geo';
import { DrivePath } from '../geo/path';
import { OsmArea, OsmBuilding, OsmFeatures, OsmPoint, fetchCity } from '../providers/open/osm';
import { mulberry32 } from './world';
import { TrafficControl, signalState } from '../sim/traffic';

// ---------------------------------------------------------------- geometry helpers

/** Signed area of a polygon in the east/north plane (positive = counter-clockwise). */
export function signedArea(pts: Vec2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** Drops the closing duplicate point and forces counter-clockwise winding. */
export function normaliseRing(pts: Vec2[]): Vec2[] {
  const ring = pts.slice();
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (ring.length > 1 && Math.hypot(first.x - last.x, first.y - last.y) < 0.01) ring.pop();
  return signedArea(ring) < 0 ? ring.reverse() : ring;
}

/** Minimum-area oriented rectangle, by trying each edge direction of the polygon. */
export function orientedBox(pts: Vec2[]) {
  let best = { area: Infinity, angle: 0, minU: 0, maxU: 0, minV: 0, maxV: 0 };
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const p of pts) {
      const u = p.x * c + p.y * s;
      const v = -p.x * s + p.y * c;
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
    const area = (maxU - minU) * (maxV - minV);
    if (area < best.area) best = { area, angle, minU, maxU, minV, maxV };
  }
  return best;
}

export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x)
      inside = !inside;
  }
  return inside;
}

/** Accumulates triangles with positions, normals, UVs and colours. */
class MeshBuilder {
  pos: number[] = [];
  uv: number[] = [];
  col: number[] = [];

  /** Adds a triangle given in three.js world coordinates; flips it if it faces away from `up`. */
  tri(
    a: THREE.Vector3,
    b: THREE.Vector3,
    c: THREE.Vector3,
    ua: [number, number],
    ub: [number, number],
    uc: [number, number],
    color: THREE.Color,
  ): void {
    this.pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    this.uv.push(...ua, ...ub, ...uc);
    for (let i = 0; i < 3; i++) this.col.push(color.r, color.g, color.b);
  }

  quad(
    a: THREE.Vector3,
    b: THREE.Vector3,
    c: THREE.Vector3,
    d: THREE.Vector3,
    uvs: [number, number][],
    color: THREE.Color,
  ): void {
    this.tri(a, b, c, uvs[0], uvs[1], uvs[2], color);
    this.tri(a, c, d, uvs[0], uvs[2], uvs[3], color);
  }

  geometry(): THREE.BufferGeometry | null {
    if (!this.pos.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeVertexNormals();
    return g;
  }
}

const v3 = (p: Vec2, h: number) => new THREE.Vector3(p.x, h, -p.y);

/**
 * Grid index over the route centre line, so "how close is this point to the
 * route, and where along it?" is a few lookups instead of a scan of the
 * whole path. Thousands of building corners are tested per chunk.
 */
export class PathIndex {
  private readonly cells = new Map<string, { x: number; y: number; s: number }[]>();
  private readonly size = 12;

  constructor(path: DrivePath) {
    const stride = 2;
    path.points(stride).forEach((p, i) => {
      const key = this.key(p.x, p.y);
      const list = this.cells.get(key);
      const item = { x: p.x, y: p.y, s: i * stride };
      if (list) list.push(item);
      else this.cells.set(key, [item]);
    });
  }

  private key(x: number, y: number): string {
    return `${Math.floor(x / this.size)},${Math.floor(y / this.size)}`;
  }

  /** Nearest route point within `radius` (≤ 12 m), or null. */
  nearest(p: Vec2, radius: number): { s: number; distance: number } | null {
    const cx = Math.floor(p.x / this.size);
    const cy = Math.floor(p.y / this.size);
    let best: { s: number; distance: number } | null = null;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const q of this.cells.get(`${cx + dx},${cy + dy}`) ?? []) {
          const d = Math.hypot(q.x - p.x, q.y - p.y);
          if (d <= radius && (!best || d < best.distance)) best = { s: q.s, distance: d };
        }
      }
    }
    return best;
  }
}

// ---------------------------------------------------------------- textures

const FACADE_BAY = 6; // metres of wall per texture repeat
const FLOOR = 3.1; // metres per floor, one texture repeat vertically

export type FacadeStyle = 'house' | 'brick' | 'stucco' | 'glass' | 'industrial';

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** One floor, two bays wide. Walls are light so per-building tints show through. */
function facadeTexture(style: FacadeStyle): THREE.CanvasTexture {
  return canvasTexture(512, 264, (g) => {
    const W = 512;
    const H = 264;
    const rnd = mulberry32(style.length * 97);
    const base = {
      house: '#f2efe8',
      brick: '#d9b9a3',
      stucco: '#f4ecdf',
      glass: '#c9d6df',
      industrial: '#dcdcd6',
    }[style];
    g.fillStyle = base;
    g.fillRect(0, 0, W, H);
    if (style === 'brick') {
      for (let y = 0; y < H; y += 8) {
        for (let x = (y / 8) % 2 ? -12 : 0; x < W; x += 24) {
          const k = 0.85 + rnd() * 0.25;
          g.fillStyle = `rgba(${150 * k},${80 * k},${60 * k},0.55)`;
          g.fillRect(x + 1, y + 1, 22, 6);
        }
      }
    } else if (style === 'house') {
      g.fillStyle = 'rgba(0,0,0,0.07)';
      for (let y = 0; y < H; y += 11) g.fillRect(0, y, W, 2); // clapboard siding
    } else if (style === 'industrial') {
      g.fillStyle = 'rgba(0,0,0,0.08)';
      for (let x = 0; x < W; x += 16) g.fillRect(x, 0, 3, H); // ribbed metal
    }
    // Floor slab line
    g.fillStyle = 'rgba(0,0,0,0.12)';
    g.fillRect(0, H - 6, W, 6);
    if (style === 'glass') {
      // Curtain wall: big panes with mullions, sky reflection gradient.
      const grad = g.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, '#6d8ea8');
      grad.addColorStop(1, '#2f4558');
      for (let x = 0; x < W; x += 64) {
        g.fillStyle = grad;
        g.fillRect(x + 3, 8, 58, H - 20);
      }
      g.fillStyle = '#9aa7b0';
      for (let x = 0; x < W; x += 64) g.fillRect(x, 0, 4, H);
      return;
    }
    // Two windows per bay with frames and sills.
    const winW = style === 'industrial' ? 120 : 70;
    const winH = style === 'industrial' ? 60 : 120;
    for (let bay = 0; bay < 4; bay++) {
      const cx = bay * 128 + 64;
      const x = cx - winW / 2;
      const y = style === 'industrial' ? 40 : 60;
      g.fillStyle = '#ffffff';
      g.fillRect(x - 6, y - 6, winW + 12, winH + 12);
      const glass = g.createLinearGradient(0, y, 0, y + winH);
      glass.addColorStop(0, '#5b7487');
      glass.addColorStop(1, '#25313b');
      g.fillStyle = glass;
      g.fillRect(x, y, winW, winH);
      g.fillStyle = 'rgba(255,255,255,0.85)';
      g.fillRect(x + winW / 2 - 2, y, 4, winH);
      g.fillRect(x, y + winH * 0.45, winW, 4);
      g.fillStyle = 'rgba(0,0,0,0.25)';
      g.fillRect(x - 8, y + winH + 6, winW + 16, 6);
    }
  });
}

function roofTexture(): THREE.CanvasTexture {
  return canvasTexture(256, 256, (g) => {
    g.fillStyle = '#7a7d82';
    g.fillRect(0, 0, 256, 256);
    const rnd = mulberry32(3);
    for (let y = 0; y < 256; y += 10) {
      for (let x = (y / 10) % 2 ? -8 : 0; x < 256; x += 16) {
        const k = 0.8 + rnd() * 0.35;
        g.fillStyle = `rgba(${90 * k},${92 * k},${96 * k},0.9)`;
        g.fillRect(x + 1, y + 1, 14, 8);
      }
    }
  });
}

function stopSignTexture(): THREE.CanvasTexture {
  return canvasTexture(256, 256, (g) => {
    g.fillStyle = '#ffffff';
    g.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = Math.PI / 8 + (i * Math.PI) / 4;
      g.lineTo(128 + Math.cos(a) * 126, 128 + Math.sin(a) * 126);
    }
    g.fill();
    g.fillStyle = '#c8102e';
    g.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = Math.PI / 8 + (i * Math.PI) / 4;
      g.lineTo(128 + Math.cos(a) * 114, 128 + Math.sin(a) * 114);
    }
    g.fill();
    g.fillStyle = '#ffffff';
    g.font = 'bold 78px Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('STOP', 128, 134);
  });
}

// ---------------------------------------------------------------- shared materials

export class CityMaterials {
  readonly facades: Record<FacadeStyle, THREE.MeshStandardMaterial>;
  readonly roof: THREE.MeshStandardMaterial;
  readonly flatRoof: THREE.MeshStandardMaterial;
  readonly road = new THREE.MeshLambertMaterial({ color: '#3d4046' });
  readonly sidewalk = new THREE.MeshLambertMaterial({ color: '#b9b5ad' });
  readonly areas: Record<OsmArea['kind'], THREE.MeshLambertMaterial> = {
    grass: new THREE.MeshLambertMaterial({ color: '#79a352' }),
    park: new THREE.MeshLambertMaterial({ color: '#6c9c48' }),
    forest: new THREE.MeshLambertMaterial({ color: '#557f3c' }),
    water: new THREE.MeshLambertMaterial({ color: '#4d7fae' }),
    parking: new THREE.MeshLambertMaterial({ color: '#56595f' }),
  };
  readonly trunk = new THREE.MeshLambertMaterial({ color: '#6b4f35' });
  readonly leaves = new THREE.MeshLambertMaterial({ color: '#4c8a3a', flatShading: true });
  readonly pole = new THREE.MeshStandardMaterial({
    color: '#4a4f57',
    metalness: 0.6,
    roughness: 0.4,
  });
  readonly signalHousing = new THREE.MeshStandardMaterial({ color: '#1b1d20', roughness: 0.6 });
  readonly stopSign: THREE.MeshBasicMaterial;

  constructor() {
    const make = (s: FacadeStyle) =>
      new THREE.MeshStandardMaterial({
        map: facadeTexture(s),
        vertexColors: true,
        roughness: s === 'glass' ? 0.25 : 0.85,
        metalness: s === 'glass' ? 0.35 : 0,
        side: THREE.DoubleSide,
      });
    this.facades = {
      house: make('house'),
      brick: make('brick'),
      stucco: make('stucco'),
      glass: make('glass'),
      industrial: make('industrial'),
    };
    const roofMap = roofTexture();
    this.roof = new THREE.MeshStandardMaterial({
      map: roofMap,
      vertexColors: true,
      roughness: 0.9,
      side: THREE.DoubleSide,
    });
    this.flatRoof = new THREE.MeshStandardMaterial({
      color: '#8d8f92',
      vertexColors: true,
      roughness: 0.95,
    });
    this.stopSign = new THREE.MeshBasicMaterial({
      map: stopSignTexture(),
      transparent: true,
      side: THREE.DoubleSide,
    });
  }

  dispose(): void {
    for (const m of [
      ...Object.values(this.facades),
      ...Object.values(this.areas),
      this.roof,
      this.flatRoof,
      this.road,
      this.sidewalk,
      this.trunk,
      this.leaves,
      this.pole,
      this.signalHousing,
      this.stopSign,
    ]) {
      (m as THREE.MeshStandardMaterial).map?.dispose();
      m.dispose();
    }
  }
}

// ---------------------------------------------------------------- buildings

const HOUSE_KINDS =
  /^(house|detached|semidetached_house|terrace|bungalow|residential|yes|garage|shed|cabin|farm)$/;
const WALL_TINTS = [
  '#ffffff',
  '#f3e7d3',
  '#e7eef3',
  '#efe1d6',
  '#e9e4cf',
  '#dfe6dc',
  '#f6eee6',
  '#e2d9cf',
];

export function facadeStyle(b: OsmBuilding, rnd: () => number): FacadeStyle {
  if (/^(office|commercial|hotel|hospital)$/.test(b.kind) || b.height > 22)
    return rnd() < 0.6 ? 'glass' : 'stucco';
  if (/^(industrial|warehouse|garage|garages|shed|hangar)$/.test(b.kind)) return 'industrial';
  if (/^(apartments|retail|school|church|civic|public)$/.test(b.kind))
    return rnd() < 0.55 ? 'brick' : 'stucco';
  return rnd() < 0.6 ? 'house' : rnd() < 0.5 ? 'brick' : 'stucco';
}

function parseColour(c: string | null, fallback: string): THREE.Color {
  if (!c) return new THREE.Color(fallback);
  try {
    // Lighten mapped colours so the facade texture detail stays visible.
    return new THREE.Color(c).lerp(new THREE.Color('#ffffff'), 0.35);
  } catch {
    return new THREE.Color(fallback);
  }
}

/** Builds wall and roof triangles for one building into the per-material builders. */
export function addBuilding(
  b: OsmBuilding,
  ring: Vec2[],
  walls: Record<FacadeStyle, MeshBuilder>,
  roofs: { pitched: MeshBuilder; flat: MeshBuilder },
  rnd: () => number,
): void {
  if (ring.length < 3) return;
  const area = Math.abs(signedArea(ring));
  if (area < 6) return;
  const style = facadeStyle(b, rnd);
  const tint = parseColour(b.colour, WALL_TINTS[Math.floor(rnd() * WALL_TINTS.length)]);
  const box = orientedBox(ring);
  const len = box.maxU - box.minU;
  const wid = box.maxV - box.minV;
  const shape = b.roofShape;
  const pitched =
    shape === 'gabled' ||
    shape === 'hipped' ||
    (shape === null &&
      HOUSE_KINDS.test(b.kind) &&
      b.height < 12 &&
      area < 400 &&
      area / box.area > 0.8);

  // With a pitched roof, walls stop at the eaves and the roof rises above.
  const rise = pitched ? Math.min(Math.min(len, wid) * 0.32, 4) : 0;
  const eaves = Math.max(b.minHeight + 2.2, b.height - rise);
  const wallRing = pitched && area / box.area > 0.8 ? boxRing(box) : ring;

  const wb = walls[style];
  let u = 0;
  for (let i = 0; i < wallRing.length; i++) {
    const a = wallRing[i];
    const c = wallRing[(i + 1) % wallRing.length];
    const edge = Math.hypot(c.x - a.x, c.y - a.y);
    const u0 = u / FACADE_BAY;
    const u1 = (u + edge) / FACADE_BAY;
    const v0 = b.minHeight / FLOOR;
    const v1 = eaves / FLOOR;
    wb.quad(
      v3(a, b.minHeight),
      v3(c, b.minHeight),
      v3(c, eaves),
      v3(a, eaves),
      [
        [u0, v0],
        [u1, v0],
        [u1, v1],
        [u0, v1],
      ],
      tint,
    );
    u += edge;
  }

  if (pitched) {
    addPitchedRoof(box, eaves, rise, shape === 'hipped', roofs.pitched, wb, tint, rnd);
  } else {
    addFlatRoof(ring, b.height, roofs.flat, new THREE.Color().setScalar(0.85 + rnd() * 0.15));
    // Short parapet wall so flat roofs read as real buildings from below.
    if (b.height > 6) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const c = ring[(i + 1) % ring.length];
        wb.quad(
          v3(a, eaves),
          v3(c, eaves),
          v3(c, eaves + 0.6),
          v3(a, eaves + 0.6),
          [
            [0, 0.95],
            [0.01, 0.95],
            [0.01, 1],
            [0, 1],
          ],
          tint,
        );
      }
    }
  }
}

function boxRing(box: ReturnType<typeof orientedBox>): Vec2[] {
  const c = Math.cos(box.angle);
  const s = Math.sin(box.angle);
  const at = (u: number, v: number) => ({ x: u * c - v * s, y: u * s + v * c });
  return [
    at(box.minU, box.minV),
    at(box.maxU, box.minV),
    at(box.maxU, box.maxV),
    at(box.minU, box.maxV),
  ];
}

function addFlatRoof(ring: Vec2[], h: number, mb: MeshBuilder, color: THREE.Color): void {
  const tris = THREE.ShapeUtils.triangulateShape(
    ring.map((p) => new THREE.Vector2(p.x, p.y)),
    [],
  );
  for (const [i, j, k] of tris) {
    const a = ring[i];
    const b = ring[j];
    const c = ring[k];
    // Counter-clockwise in east/north is counter-clockwise seen from above.
    const ccw = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y) > 0;
    const [p, q] = ccw ? [b, c] : [c, b];
    mb.tri(
      v3(a, h),
      v3(p, h),
      v3(q, h),
      [a.x / 8, a.y / 8],
      [p.x / 8, p.y / 8],
      [q.x / 8, q.y / 8],
      color,
    );
  }
}

function addPitchedRoof(
  box: ReturnType<typeof orientedBox>,
  eaves: number,
  rise: number,
  hipped: boolean,
  roof: MeshBuilder,
  wall: MeshBuilder,
  tint: THREE.Color,
  rnd: () => number,
): void {
  // Ridge runs along the longer side of the footprint.
  const longU = box.maxU - box.minU >= box.maxV - box.minV;
  const c = Math.cos(box.angle);
  const s = Math.sin(box.angle);
  const o = 0.35; // eave overhang
  const at = (uu: number, vv: number) => ({ x: uu * c - vv * s, y: uu * s + vv * c });
  // Work in (along, across) and map back to (u, v).
  const [a0, a1, b0, b1] = longU
    ? [box.minU - o, box.maxU + o, box.minV - o, box.maxV + o]
    : [box.minV - o, box.maxV + o, box.minU - o, box.maxU + o];
  const P = (along: number, across: number) => (longU ? at(along, across) : at(across, along));
  const mid = (b0 + b1) / 2;
  const inset = hipped ? (b1 - b0) / 2 : 0;
  const ridgeH = eaves + rise;
  const r0 = v3(P(a0 + inset, mid), ridgeH);
  const r1 = v3(P(a1 - inset, mid), ridgeH);
  const e00 = v3(P(a0, b0), eaves);
  const e10 = v3(P(a1, b0), eaves);
  const e11 = v3(P(a1, b1), eaves);
  const e01 = v3(P(a0, b1), eaves);
  const roofColor = new THREE.Color(
    ['#8b4a3c', '#5b5f66', '#6e5a4b', '#3f4348', '#7c6f63'][Math.floor(rnd() * 5)],
  );
  const L = a1 - a0;
  const D = (b1 - b0) / 2 / Math.cos(Math.atan2(rise, (b1 - b0) / 2));
  const uv = (x: number, y: number): [number, number] => [x / 3, y / 3];
  // Both slopes, wound so they face outward/up whichever axis is long.
  const flip = !longU;
  const quad = (p: THREE.Vector3, q: THREE.Vector3, r: THREE.Vector3, t: THREE.Vector3) =>
    flip
      ? roof.quad(p, t, r, q, [uv(0, 0), uv(0, D), uv(L, D), uv(L, 0)], roofColor)
      : roof.quad(p, q, r, t, [uv(0, 0), uv(L, 0), uv(L, D), uv(0, D)], roofColor);
  quad(e00, e10, r1, r0);
  quad(e11, e01, r0, r1);
  if (hipped) {
    const tri = (p: THREE.Vector3, q: THREE.Vector3, r: THREE.Vector3) =>
      flip
        ? roof.tri(p, r, q, uv(0, 0), uv(1, 2), uv(2, 0), roofColor)
        : roof.tri(p, q, r, uv(0, 0), uv(2, 0), uv(1, 2), roofColor);
    tri(e01, e00, r0);
    tri(e10, e11, r1);
  } else {
    // Gable ends are wall, using the facade texture.
    const g0 = [
      v3(P(a0 + o, b0 + o), eaves),
      v3(P(a0 + o, b1 - o), eaves),
      v3(P(a0 + o, mid), ridgeH),
    ] as const;
    const g1 = [
      v3(P(a1 - o, b1 - o), eaves),
      v3(P(a1 - o, b0 + o), eaves),
      v3(P(a1 - o, mid), ridgeH),
    ] as const;
    const v0 = eaves / FLOOR;
    const v1 = ridgeH / FLOOR;
    const w = (b1 - b0 - 2 * o) / FACADE_BAY;
    for (const [p, q, r] of [g0, g1]) {
      if (flip) wall.tri(p, r, q, [0, v0], [w / 2, v1], [w, v0], tint);
      else wall.tri(q, p, r, [w, v0], [0, v0], [w / 2, v1], tint);
    }
  }
}

// ---------------------------------------------------------------- flat layers

/** A ribbon of constant width along a polyline (local metres), as triangles. */
function addRibbon(
  line: Vec2[],
  halfWidth: number,
  h: number,
  mb: MeshBuilder,
  color: THREE.Color,
): void {
  if (line.length < 2) return;
  const normals = line.map((_, i) => {
    const a = line[Math.max(0, i - 1)];
    const b = line[Math.min(line.length - 1, i + 1)];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return { x: (b.y - a.y) / len, y: -(b.x - a.x) / len }; // right-hand normal
  });
  let dist = 0;
  for (let i = 0; i < line.length - 1; i++) {
    const p = line[i];
    const q = line[i + 1];
    const seg = Math.hypot(q.x - p.x, q.y - p.y);
    const L = (pt: Vec2, n: Vec2, k: number) => ({
      x: pt.x + n.x * halfWidth * k,
      y: pt.y + n.y * halfWidth * k,
    });
    const pl = L(p, normals[i], -1);
    const pr = L(p, normals[i], 1);
    const ql = L(q, normals[i + 1], -1);
    const qr = L(q, normals[i + 1], 1);
    const u0 = dist / 8;
    const u1 = (dist + seg) / 8;
    // Up-facing in three.js: left, right, next-right / left, next-right, next-left
    mb.quad(
      v3(pl, h),
      v3(pr, h),
      v3(qr, h),
      v3(ql, h),
      [
        [0, u0],
        [1, u0],
        [1, u1],
        [0, u1],
      ],
      color,
    );
    dist += seg;
  }
  // Round caps so road ends and joints don't show gaps.
  for (const [pt, idx] of [
    [line[0], 0],
    [line[line.length - 1], line.length - 1],
  ] as const) {
    const n = normals[idx];
    const steps = 6;
    for (let k = 0; k < steps; k++) {
      const a0 = Math.atan2(n.y, n.x) + (Math.PI * k) / steps;
      const a1 = Math.atan2(n.y, n.x) + (Math.PI * (k + 1)) / steps;
      for (const sign of [1, -1]) {
        const p0 = {
          x: pt.x + Math.cos(a0 * sign) * halfWidth,
          y: pt.y + Math.sin(a0 * sign) * halfWidth,
        };
        const p1 = {
          x: pt.x + Math.cos(a1 * sign) * halfWidth,
          y: pt.y + Math.sin(a1 * sign) * halfWidth,
        };
        const ccw = (p0.x - pt.x) * (p1.y - pt.y) - (p1.x - pt.x) * (p0.y - pt.y) > 0;
        const [m, r] = ccw ? [p0, p1] : [p1, p0];
        mb.tri(v3(pt, h), v3(m, h), v3(r, h), [0.5, 0], [0, 0], [1, 0], color);
      }
    }
  }
}

function addPolygon(ring: Vec2[], h: number, mb: MeshBuilder, color: THREE.Color): void {
  addFlatRoof(ring, h, mb, color);
}

// ---------------------------------------------------------------- chunk

const SIDEWALK_ROADS =
  /^(primary|secondary|tertiary|residential|unclassified|living_street|trunk)$/;

function flat(mesh: THREE.Mesh, order: number, receive = true): THREE.Mesh {
  (mesh.material as THREE.Material).depthWrite = false;
  mesh.renderOrder = order;
  mesh.receiveShadow = receive;
  return mesh;
}

/**
 * Turns one chunk of OpenStreetMap data into scene objects: merged meshes per
 * material for buildings, roofs, roads, sidewalks and green areas, instanced
 * trees, and traffic-control props along the route.
 */
export function buildChunk(
  f: OsmFeatures,
  proj: LocalProjection,
  path: DrivePath,
  index: PathIndex,
  mats: CityMaterials,
  seenBuildings: Set<number>,
  seed: number,
): { group: THREE.Group; controls: TrafficControl[]; signals: SignalProp[] } {
  const group = new THREE.Group();
  const rnd = mulberry32(seed);
  const local = (pts: { lat: number; lng: number }[]) => pts.map((p) => proj.toLocal(p));
  const white = new THREE.Color('#ffffff');

  // Buildings
  const walls = {
    house: new MeshBuilder(),
    brick: new MeshBuilder(),
    stucco: new MeshBuilder(),
    glass: new MeshBuilder(),
    industrial: new MeshBuilder(),
  };
  const roofs = { pitched: new MeshBuilder(), flat: new MeshBuilder() };
  const footprints: Vec2[][] = [];
  for (const b of f.buildings) {
    if (seenBuildings.has(b.id)) continue;
    seenBuildings.add(b.id);
    const ring = normaliseRing(local(b.outline));
    // Never let a building stand on the route itself (mapping errors, bridges).
    if (ring.some((p) => index.nearest(p, 3))) continue;
    footprints.push(ring);
    addBuilding(b, ring, walls, roofs, rnd);
  }
  for (const [style, mb] of Object.entries(walls) as [FacadeStyle, MeshBuilder][]) {
    const g = mb.geometry();
    if (!g) continue;
    const m = new THREE.Mesh(g, mats.facades[style]);
    m.castShadow = m.receiveShadow = true;
    group.add(m);
  }
  for (const [g, mat] of [
    [roofs.pitched.geometry(), mats.roof],
    [roofs.flat.geometry(), mats.flatRoof],
  ] as const) {
    if (!g) continue;
    const m = new THREE.Mesh(g, mat);
    m.castShadow = m.receiveShadow = true;
    group.add(m);
  }

  // Roads and sidewalks (the route's own road is drawn separately, above these).
  const roadMb = new MeshBuilder();
  const walkMb = new MeshBuilder();
  for (const r of f.roads) {
    const line = local(r.line);
    addRibbon(line, r.width / 2, 0.02, roadMb, white);
    if (SIDEWALK_ROADS.test(r.kind)) addRibbon(line, r.width / 2 + 2.2, 0.03, walkMb, white);
  }
  const walkG = walkMb.geometry();
  if (walkG) group.add(flat(new THREE.Mesh(walkG, mats.sidewalk), -8.6));
  const roadG = roadMb.geometry();
  if (roadG) group.add(flat(new THREE.Mesh(roadG, mats.road), -8.2));

  // Green spaces, water, parking
  const areaMbs = new Map<OsmArea['kind'], MeshBuilder>();
  for (const a of f.areas) {
    const ring = normaliseRing(local(a.outline));
    if (ring.length < 3) continue;
    if (!areaMbs.has(a.kind)) areaMbs.set(a.kind, new MeshBuilder());
    addPolygon(ring, 0.01, areaMbs.get(a.kind)!, white);
  }
  for (const [kind, mb] of areaMbs) {
    const g = mb.geometry();
    if (g) group.add(flat(new THREE.Mesh(g, mats.areas[kind]), kind === 'parking' ? -8.7 : -8.9));
  }

  // Trees: mapped ones, plus fill for parks and woods.
  const trees: Vec2[] = f.points.filter((p) => p.kind === 'tree').map((p) => proj.toLocal(p.at));
  for (const a of f.areas) {
    if (a.kind !== 'park' && a.kind !== 'forest') continue;
    const ring = normaliseRing(local(a.outline));
    const area = Math.abs(signedArea(ring));
    const n = Math.min(120, Math.floor(area / (a.kind === 'forest' ? 60 : 220)));
    const xs = ring.map((p) => p.x);
    const ys = ring.map((p) => p.y);
    for (let i = 0, tries = 0; i < n && tries < n * 4; tries++) {
      const p = {
        x: Math.min(...xs) + rnd() * (Math.max(...xs) - Math.min(...xs)),
        y: Math.min(...ys) + rnd() * (Math.max(...ys) - Math.min(...ys)),
      };
      if (pointInPolygon(p, ring)) {
        trees.push(p);
        i++;
      }
    }
  }
  const clearOfBuildings = (p: Vec2) => !footprints.some((fp) => pointInPolygon(p, fp));
  const placed = trees.filter((p) => clearOfBuildings(p) && !index.nearest(p, 5));
  if (placed.length) group.add(treeInstances(placed, mats, rnd));

  // Traffic controls on the route
  const { props, controls, signals } = trafficProps(f.points, proj, path, index, mats);
  group.add(props);
  return { group, controls, signals };
}

function treeInstances(points: Vec2[], mats: CityMaterials, rnd: () => number): THREE.Group {
  const g = new THREE.Group();
  const trunkGeo = new THREE.CylinderGeometry(0.16, 0.24, 2.6, 6).translate(0, 1.3, 0);
  const crownGeo = mergeGeometries([
    new THREE.IcosahedronGeometry(2.1, 1).translate(0, 4.1, 0),
    new THREE.IcosahedronGeometry(1.5, 1).translate(0.9, 5.2, 0.4),
    new THREE.IcosahedronGeometry(1.4, 1).translate(-0.8, 5.0, -0.5),
  ])!;
  const trunks = new THREE.InstancedMesh(trunkGeo, mats.trunk, points.length);
  const crowns = new THREE.InstancedMesh(crownGeo, mats.leaves, points.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const sc = new THREE.Vector3();
  const col = new THREE.Color();
  points.forEach((p, i) => {
    const k = 0.75 + rnd() * 0.6;
    m.compose(
      new THREE.Vector3(p.x, 0, -p.y),
      q.setFromEuler(new THREE.Euler(0, rnd() * 6.3, 0)),
      sc.set(k, k, k),
    );
    trunks.setMatrixAt(i, m);
    crowns.setMatrixAt(i, m);
    crowns.setColorAt(i, col.setHSL(0.24 + rnd() * 0.08, 0.45, 0.32 + rnd() * 0.1));
  });
  for (const mesh of [trunks, crowns]) {
    mesh.castShadow = true;
    mesh.frustumCulled = false;
    g.add(mesh);
  }
  return g;
}

// ---------------------------------------------------------------- traffic controls

export interface SignalProp {
  id: number;
  lights: [THREE.MeshStandardMaterial, THREE.MeshStandardMaterial, THREE.MeshStandardMaterial];
}

function trafficProps(
  points: OsmPoint[],
  proj: LocalProjection,
  path: DrivePath,
  index: PathIndex,
  mats: CityMaterials,
) {
  const props = new THREE.Group();
  const controls: TrafficControl[] = [];
  const signals: SignalProp[] = [];
  const poleGeo = new THREE.CylinderGeometry(0.07, 0.09, 1, 8).translate(0, 0.5, 0);
  for (const p of points) {
    if (p.kind !== 'stop' && p.kind !== 'traffic_signals') continue;
    const at = proj.toLocal(p.at);
    const near = index.nearest(at, 12);
    if (!near) continue;
    const hit = path.project(at, near.s);
    if (hit.distance > (p.kind === 'stop' ? 6 : 12)) continue;
    // Stop lines sit a few metres before the mapped node (usually the junction).
    const stopS = Math.max(0, hit.s - (p.kind === 'stop' ? 3 : 8));
    if (controls.some((c) => c.kind === p.kind && Math.abs(c.s - stopS) < 15)) continue;
    controls.push({ id: p.id, kind: p.kind, s: stopS });
    // Post on the kerb to the right of the approaching car, facing it.
    const w = path.toWorld(stopS, 5.4);
    const yaw = -(w.heading + Math.PI); // face back toward the approaching car
    const holder = new THREE.Group();
    holder.position.set(w.x, 0, -w.y);
    holder.rotation.y = yaw;
    if (p.kind === 'stop') {
      const pole = new THREE.Mesh(poleGeo, mats.pole);
      pole.scale.y = 2.1;
      const sign = new THREE.Mesh(
        new THREE.CircleGeometry(0.38, 8).rotateZ(Math.PI / 8),
        mats.stopSign,
      );
      sign.position.set(0, 2.25, 0.08);
      holder.add(pole, sign);
    } else {
      const pole = new THREE.Mesh(poleGeo, mats.pole);
      pole.scale.y = 5.6;
      // Mast arm reaching over the lane, with the signal head above the car.
      const arm = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.14, 0.14), mats.pole);
      arm.position.set(2.1, 5.5, 0);
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.36, 1.05, 0.3), mats.signalHousing);
      head.position.set(3.4, 4.85, 0.1);
      const lamps = (['#ff3b30', '#ffcc00', '#34c759'] as const).map((c, i) => {
        const mat = new THREE.MeshStandardMaterial({
          color: '#222',
          emissive: c,
          emissiveIntensity: 0,
        });
        const lamp = new THREE.Mesh(new THREE.CircleGeometry(0.12, 16), mat);
        lamp.position.set(3.4, 5.2 - i * 0.34, 0.26);
        holder.add(lamp);
        return mat;
      }) as SignalProp['lights'];
      holder.add(pole, arm, head);
      signals.push({ id: p.id, lights: lamps });
    }
    holder.traverse((o) => (o.castShadow = true));
    props.add(holder);
  }
  return { props, controls, signals };
}

// ---------------------------------------------------------------- streaming layer

const CHUNK_LENGTH = 700; // metres of route per Overpass request
const CORRIDOR = 140; // metres either side of the route

/**
 * Streams the 3D city along the route in chunks, like a game's render
 * distance: the chunk under the car and the next ones ahead are built,
 * chunks far behind are freed.
 */
export class CityLayer {
  readonly group = new THREE.Group();
  readonly controls: TrafficControl[] = [];
  private readonly signals: SignalProp[] = [];
  private readonly mats = new CityMaterials();
  private readonly index: PathIndex;
  private readonly chunks = new Map<number, THREE.Group>();
  private readonly requested = new Set<number>();
  private readonly seen = new Set<number>();
  private loading = false;
  private failures = 0;
  /** True once at least one chunk has loaded successfully. */
  ready = false;
  onReady?: () => void;
  onError?: (msg: string) => void;

  constructor(
    private readonly path: DrivePath,
    private readonly fetcher: typeof fetchCity = fetchCity,
  ) {
    this.group.name = 'osm-city';
    this.index = new PathIndex(path);
  }

  update(s: number, time: number, lookahead: number): void {
    const first = Math.max(0, Math.floor((s - 200) / CHUNK_LENGTH));
    const last = Math.floor(
      Math.min(this.path.length, s + lookahead + CHUNK_LENGTH / 2) / CHUNK_LENGTH,
    );
    for (let i = first; i <= last; i++) {
      if (!this.requested.has(i) && !this.loading && this.failures < 3) {
        this.load(i);
        break;
      }
    }
    for (const [i, g] of this.chunks) {
      if ((i + 1) * CHUNK_LENGTH < s - 600) {
        g.traverse((o) => {
          if (o instanceof THREE.Mesh) o.geometry.dispose();
        });
        this.group.remove(g);
        this.chunks.delete(i);
      }
    }
    for (const sig of this.signals) {
      const state = signalState(sig.id, time);
      sig.lights[0].emissiveIntensity = state === 'red' ? 2.2 : 0;
      sig.lights[1].emissiveIntensity = state === 'yellow' ? 2.2 : 0;
      sig.lights[2].emissiveIntensity = state === 'green' ? 2.2 : 0;
    }
  }

  private load(i: number): void {
    this.requested.add(i);
    this.loading = true;
    const from = i * CHUNK_LENGTH;
    const to = Math.min(this.path.length, from + CHUNK_LENGTH);
    const line = [];
    for (let at = from; at <= to; at += 25) line.push(this.path.toLatLng(this.path.sample(at)));
    line.push(this.path.toLatLng(this.path.sample(to)));
    this.fetcher(line, CORRIDOR)
      .then((features) => {
        const { group, controls, signals } = buildChunk(
          features,
          this.path.projection,
          this.path,
          this.index,
          this.mats,
          this.seen,
          i + 1,
        );
        this.chunks.set(i, group);
        this.group.add(group);
        this.controls.push(...controls);
        this.controls.sort((a, b) => a.s - b.s);
        this.signals.push(...signals);
        if (!this.ready) {
          this.ready = true;
          this.onReady?.();
        }
      })
      .catch((err: Error) => {
        this.failures++;
        this.requested.delete(i);
        console.warn('3D city:', err.message);
        if (this.failures === 3)
          this.onError?.(
            'Could not load OpenStreetMap buildings. Showing the simple road instead.',
          );
      })
      .finally(() => (this.loading = false));
  }

  nextControl(s: number): TrafficControl | null {
    return this.controls.find((c) => c.s > s - 1) ?? null;
  }

  dispose(): void {
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    this.mats.dispose();
  }
}
