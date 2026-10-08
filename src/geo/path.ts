import { LatLng, LocalProjection, Vec2, clamp, wrapPi } from './geo';
import { RouteData, RouteStep, signalFor } from './route';

export interface PathSample {
  x: number;
  y: number;
  /** Compass heading in radians: 0 = north, positive = clockwise. */
  heading: number;
  /** Signed curvature in 1/m: positive bends to the right. */
  curvature: number;
}

export interface PathStep extends RouteStep {
  /** Distance along the path where the manoeuvre happens. */
  s: number;
  signal: 'left' | 'right' | null;
}

export interface PathSpeedLimit {
  start: number;
  end: number;
  metersPerSecond: number;
}

const SAMPLE_SPACING = 1; // metres between path samples
const COARSE_SPACING = 16; // metres; sets the tightest corner radius after smoothing

/**
 * Resamples a polyline so consecutive points are `spacing` metres apart
 * (measured along the line). Always keeps the first and last point.
 */
export function resample(points: Vec2[], spacing: number): Vec2[] {
  if (points.length < 2) return points.slice();
  const out: Vec2[] = [points[0]];
  let carry = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len === 0) continue;
    let d = spacing - carry;
    while (d <= len) {
      const t = d / len;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      d += spacing;
    }
    carry = len - (d - spacing);
  }
  const last = points[points.length - 1];
  const tail = out[out.length - 1];
  if (Math.hypot(last.x - tail.x, last.y - tail.y) > spacing * 0.25) out.push(last);
  else out[out.length - 1] = last;
  return out;
}

/** Chaikin corner cutting: rounds sharp intersection corners into drivable arcs. */
export function chaikin(points: Vec2[], iterations: number): Vec2[] {
  let pts = points;
  for (let k = 0; k < iterations; k++) {
    if (pts.length < 3) return pts;
    const next: Vec2[] = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      next.push({ x: 0.75 * a.x + 0.25 * b.x, y: 0.75 * a.y + 0.25 * b.y });
      next.push({ x: 0.25 * a.x + 0.75 * b.x, y: 0.25 * a.y + 0.75 * b.y });
    }
    next.push(pts[pts.length - 1]);
    pts = next;
  }
  return pts;
}

/**
 * The route as a smooth, uniformly sampled centre line in local metres. The
 * vehicle model drives along it in Frenet coordinates (distance s, lateral
 * offset d), which keeps the car on mapped roads while still making the driver
 * steer through every curve.
 */
export class DrivePath {
  readonly projection: LocalProjection;
  readonly length: number;
  readonly steps: PathStep[];
  readonly speedLimits: PathSpeedLimit[];
  private readonly xs: Float64Array;
  private readonly ys: Float64Array;
  private readonly headings: Float64Array;
  private readonly curvatures: Float64Array;

  constructor(route: RouteData) {
    if (route.points.length < 2) throw new Error('A route needs at least two points.');
    this.projection = new LocalProjection(route.points[0]);
    const raw = route.points.map((p) => this.projection.toLocal(p));
    const coarse = resample(raw, COARSE_SPACING);
    const smooth = resample(chaikin(coarse, 4), SAMPLE_SPACING);

    const n = smooth.length;
    this.xs = new Float64Array(n);
    this.ys = new Float64Array(n);
    this.headings = new Float64Array(n);
    this.curvatures = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.xs[i] = smooth[i].x;
      this.ys[i] = smooth[i].y;
    }
    for (let i = 0; i < n; i++) {
      const a = smooth[Math.max(0, i - 1)];
      const b = smooth[Math.min(n - 1, i + 1)];
      this.headings[i] = Math.atan2(b.x - a.x, b.y - a.y);
    }
    // Curvature from heading change, lightly smoothed to remove sampling noise.
    const raw_k = new Float64Array(n);
    for (let i = 1; i < n - 1; i++) {
      raw_k[i] = wrapPi(this.headings[i + 1] - this.headings[i - 1]) / (2 * SAMPLE_SPACING);
    }
    const w = 3;
    for (let i = 0; i < n; i++) {
      let sum = 0;
      let count = 0;
      for (let j = Math.max(0, i - w); j <= Math.min(n - 1, i + w); j++) {
        sum += raw_k[j];
        count++;
      }
      this.curvatures[i] = sum / count;
    }
    this.length = (n - 1) * SAMPLE_SPACING;

    this.steps = route.steps
      .map((step) => ({
        ...step,
        s: this.project(this.projection.toLocal(step.location)).s,
        signal: signalFor(step.maneuver),
      }))
      .sort((a, b) => a.s - b.s);

    this.speedLimits = route.speedLimits.map((span) => ({
      start: this.project(raw[clamp(span.from, 0, raw.length - 1)]).s,
      end: this.project(raw[clamp(span.to, 0, raw.length - 1)]).s,
      metersPerSecond: span.metersPerSecond,
    }));
  }

  get sampleCount(): number {
    return this.xs.length;
  }

  /** Interpolated centre-line sample at distance s (clamped to the path). */
  sample(s: number): PathSample {
    const f = clamp(s, 0, this.length) / SAMPLE_SPACING;
    const i = Math.min(Math.floor(f), this.xs.length - 2);
    const t = f - i;
    const dh = wrapPi(this.headings[i + 1] - this.headings[i]);
    return {
      x: this.xs[i] + (this.xs[i + 1] - this.xs[i]) * t,
      y: this.ys[i] + (this.ys[i + 1] - this.ys[i]) * t,
      heading: this.headings[i] + dh * t,
      curvature: this.curvatures[i] + (this.curvatures[i + 1] - this.curvatures[i]) * t,
    };
  }

  /** World position for Frenet coordinates (d > 0 is right of the centre line). */
  toWorld(s: number, d: number): Vec2 & { heading: number } {
    const p = this.sample(s);
    return {
      x: p.x + Math.cos(p.heading) * d,
      y: p.y - Math.sin(p.heading) * d,
      heading: p.heading,
    };
  }

  /** Nearest point on the path to a local position. */
  project(p: Vec2, hint?: number): { s: number; distance: number } {
    let best = Infinity;
    let bestI = 0;
    const n = this.xs.length;
    let lo = 0;
    let hi = n;
    if (hint !== undefined) {
      const c = Math.round(hint / SAMPLE_SPACING);
      lo = Math.max(0, c - 200);
      hi = Math.min(n, c + 200);
    }
    for (let i = lo; i < hi; i++) {
      const dx = this.xs[i] - p.x;
      const dy = this.ys[i] - p.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < best) {
        best = d2;
        bestI = i;
      }
    }
    return { s: bestI * SAMPLE_SPACING, distance: Math.sqrt(best) };
  }

  /** Speed limit in m/s at s, if the provider supplied one. */
  speedLimitAt(s: number): number | null {
    for (const span of this.speedLimits) {
      if (s >= span.start && s < span.end) return span.metersPerSecond;
    }
    return null;
  }

  /** The next manoeuvre at or ahead of s. */
  nextStep(s: number): PathStep | null {
    for (const step of this.steps) {
      if (step.s > s + 1 && step.maneuver !== 'depart') return step;
    }
    return null;
  }

  toLatLng(p: Vec2): LatLng {
    return this.projection.toLatLng(p);
  }

  /** Every Nth sample as local points, for building scenery meshes. */
  points(stride = 1): Vec2[] {
    const out: Vec2[] = [];
    for (let i = 0; i < this.xs.length; i += stride) out.push({ x: this.xs[i], y: this.ys[i] });
    return out;
  }
}
