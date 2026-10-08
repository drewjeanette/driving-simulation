import { LatLng, LocalProjection, Vec2 } from '../../geo/geo';
import { SpeedLimitSpan } from '../../geo/route';
import { fetchJson } from '../types';

/**
 * Posted speed limits from OpenStreetMap `maxspeed` tags, via the free
 * Overpass API. The public OSRM server doesn't return limits, so this fills
 * the gap for the examiner's speeding checks. Best effort: any failure just
 * means no limits for that drive.
 */
const OVERPASS = 'https://overpass-api.de/api/interpreter';
const MATCH_RADIUS = 12; // metres between the route and a tagged road

interface OverpassWay {
  type: 'way';
  tags?: { maxspeed?: string };
  geometry?: { lat: number; lon: number }[];
}

/** Parses an OSM maxspeed value ("50", "30 mph", "50 km/h") to m/s; null if unusable. */
export function parseMaxspeed(value: string | undefined): number | null {
  if (!value) return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh|kph)?\s*$/i.exec(value);
  if (!m) return null; // "none", "walk", "signals", zone codes like "DE:urban"
  const n = Number(m[1]);
  if (!(n > 0 && n < 200)) return null;
  return m[2]?.toLowerCase() === 'mph' ? n * 0.44704 : n / 3.6;
}

function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * Assigns each route segment (points[i] to points[i+1]) the limit of the
 * nearest tagged road, then merges runs of equal limits into spans.
 */
export function assignLimits(points: LatLng[], ways: OverpassWay[]): SpeedLimitSpan[] {
  if (points.length < 2) return [];
  const proj = new LocalProjection(points[0]);
  const roads = ways
    .map((w) => ({
      mps: parseMaxspeed(w.tags?.maxspeed),
      pts: (w.geometry ?? []).map((g) => proj.toLocal({ lat: g.lat, lng: g.lon })),
    }))
    .filter((r): r is { mps: number; pts: Vec2[] } => r.mps !== null && r.pts.length > 1);
  const spans: SpeedLimitSpan[] = [];
  const local = points.map((p) => proj.toLocal(p));
  for (let i = 0; i < local.length - 1; i++) {
    const mid = { x: (local[i].x + local[i + 1].x) / 2, y: (local[i].y + local[i + 1].y) / 2 };
    let best = MATCH_RADIUS;
    let mps: number | null = null;
    for (const r of roads) {
      for (let k = 0; k < r.pts.length - 1; k++) {
        const d = distToSegment(mid, r.pts[k], r.pts[k + 1]);
        if (d < best) {
          best = d;
          mps = r.mps;
        }
      }
    }
    if (mps === null) continue;
    const last = spans[spans.length - 1];
    if (last && last.to === i && Math.abs(last.metersPerSecond - mps) < 0.01) last.to = i + 1;
    else spans.push({ from: i, to: i + 1, metersPerSecond: mps });
  }
  return spans;
}

/** Thins a polyline to at most `max` points for the Overpass "around" filter. */
function thin(points: LatLng[], max: number): LatLng[] {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => points[Math.round(i * step)]);
}

export async function fetchSpeedLimits(points: LatLng[]): Promise<SpeedLimitSpan[]> {
  const line = thin(points, 250)
    .map((p) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`)
    .join(',');
  const query = `[out:json][timeout:15];way(around:${MATCH_RADIUS},${line})[highway][maxspeed];out tags geom;`;
  const body = await fetchJson<{ elements: OverpassWay[] }>(
    OVERPASS,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ data: query }).toString(),
    },
    10_000,
  );
  return assignLimits(points, body.elements ?? []);
}
