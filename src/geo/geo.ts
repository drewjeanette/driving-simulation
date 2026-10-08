export interface LatLng {
  lat: number;
  lng: number;
}

/** A point in a local East-North plane, in metres. */
export interface Vec2 {
  x: number;
  y: number;
}

export const EARTH_RADIUS_M = 6_371_008.8;
const DEG = Math.PI / 180;

export function toRad(deg: number): number {
  return deg * DEG;
}

export function toDeg(rad: number): number {
  return rad / DEG;
}

/** Great-circle distance between two coordinates, in metres. */
export function haversine(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Normalises an angle in degrees to [0, 360). */
export function wrap360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Normalises an angle in radians to (-PI, PI]. */
export function wrapPi(rad: number): number {
  let r = rad % (2 * Math.PI);
  if (r <= -Math.PI) r += 2 * Math.PI;
  if (r > Math.PI) r -= 2 * Math.PI;
  return r;
}

/**
 * Equirectangular projection around an origin. Accurate to well under a metre
 * over the few tens of kilometres a practice route covers, and cheap enough to
 * run every frame.
 */
export class LocalProjection {
  private readonly cosLat: number;

  constructor(readonly origin: LatLng) {
    this.cosLat = Math.cos(toRad(origin.lat));
  }

  toLocal(p: LatLng): Vec2 {
    return {
      x: toRad(p.lng - this.origin.lng) * EARTH_RADIUS_M * this.cosLat,
      y: toRad(p.lat - this.origin.lat) * EARTH_RADIUS_M,
    };
  }

  toLatLng(v: Vec2): LatLng {
    return {
      lat: this.origin.lat + toDeg(v.y / EARTH_RADIUS_M),
      lng: this.origin.lng + toDeg(v.x / (EARTH_RADIUS_M * this.cosLat)),
    };
  }
}

/** Compass heading (0 = north, clockwise, degrees) of a local direction vector. */
export function headingOf(dx: number, dy: number): number {
  return wrap360(toDeg(Math.atan2(dx, dy)));
}

/** Decodes a Google encoded polyline (precision 5). */
export function decodePolyline(encoded: string, precision = 5): LatLng[] {
  const factor = 10 ** precision;
  const out: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    for (const axis of [0, 1]) {
      let result = 0;
      let shift = 0;
      let byte: number;
      do {
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20 && index < encoded.length);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta;
      else lng += delta;
    }
    out.push({ lat: lat / factor, lng: lng / factor });
  }
  return out;
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Frame-rate independent exponential approach of `current` toward `target`. */
export function damp(current: number, target: number, rate: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-rate * dt));
}
