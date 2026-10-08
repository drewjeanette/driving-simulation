import { LatLng, LocalProjection } from '../geo/geo';
import { DrivePath } from '../geo/path';
import { ImageryQuality, PanoInfo, PanoSource, loadImage, samplePoints } from './imagery';
import { fetchJson } from './types';

/**
 * Free 360° street-level imagery from Mapillary (CC BY-SA 4.0), through its
 * public Graph API. Needs only a free client token, no billing account.
 *
 * https://www.mapillary.com/developer/api-documentation
 */
const GRAPH = 'https://graph.mapillary.com';

/** A Mapillary client token looks like "MLY|<app id>|<32 hex chars>". */
export function isPlausibleMapillaryToken(token: string): boolean {
  return /^MLY\|\d+\|[0-9a-f]{32}$/i.test(token.trim());
}

const FIELDS = [
  'id',
  'geometry',
  'computed_geometry',
  'compass_angle',
  'computed_compass_angle',
  'captured_at',
  'creator',
  'sequence',
  'thumb_1024_url',
  'thumb_2048_url',
  'thumb_original_url',
].join(',');

export interface MapillaryImage {
  id: string;
  geometry?: { coordinates: [number, number] };
  computed_geometry?: { coordinates: [number, number] };
  compass_angle?: number;
  computed_compass_angle?: number;
  captured_at?: number;
  creator?: { username?: string };
  sequence?: string;
  thumb_1024_url?: string;
  thumb_2048_url?: string;
  thumb_original_url?: string;
}

export interface Candidate {
  id: string;
  /** Distance along the route, m. */
  s: number;
  /** Distance from the route's centre line, m. */
  offset: number;
  sequence: string;
  capturedAt: number;
}

/**
 * Picks one photo roughly every `spacing` metres along the route. Mapillary
 * often has several overlapping sequences (different years, directions,
 * contributors) on the same street; switching between them every few metres
 * makes the view flicker, so the score favours staying on one sequence, then
 * photos close to the road, then recent ones.
 */
export function selectPanos(
  candidates: Candidate[],
  spacing = 6,
  previousSequence: string | null = null,
  now = Date.now(),
): Candidate[] {
  const bins = new Map<number, Candidate[]>();
  for (const c of candidates) {
    const k = Math.floor(c.s / spacing);
    const bin = bins.get(k);
    if (bin) bin.push(c);
    else bins.set(k, [c]);
  }
  const out: Candidate[] = [];
  let seq = previousSequence;
  for (const k of [...bins.keys()].sort((a, b) => a - b)) {
    let best: Candidate | null = null;
    let bestScore = Infinity;
    for (const c of bins.get(k)!) {
      const years = Math.max(0, (now - c.capturedAt) / (365.25 * 24 * 3600 * 1000));
      const score = c.offset + (seq !== null && c.sequence !== seq ? 5 : 0) + years * 0.6;
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (best) {
      out.push(best);
      seq = best.sequence;
    }
  }
  return out;
}

export class MapillarySource implements PanoSource {
  readonly name = 'Mapillary';
  readonly credit = 'Imagery © Mapillary contributors (CC BY-SA)';
  readonly unavailableMessage =
    'Mapillary imagery could not be loaded (check the client token). Showing the simulated road instead.';
  private lastSequence: string | null = null;

  constructor(private readonly token: string) {}

  private async query(bbox: [number, number, number, number], limit: number, fields = FIELDS) {
    const params = new URLSearchParams({
      access_token: this.token,
      fields,
      is_pano: 'true',
      bbox: bbox.map((v) => v.toFixed(6)).join(','),
      limit: String(limit),
    });
    const body = await fetchJson<{ data: MapillaryImage[] }>(`${GRAPH}/images?${params}`);
    return body.data ?? [];
  }

  async discover(path: DrivePath, from: number, to: number): Promise<PanoInfo[]> {
    // Query small boxes along the route; a single big box would mostly
    // return photos from side streets and hit the API's area limit.
    const boxes: [number, number, number, number][] = [];
    const end = Math.min(to, path.length);
    for (let a = from; a < end; a += 200) {
      const pts = [];
      for (let s = a; s <= Math.min(a + 200, end); s += 25) pts.push(path.toLatLng(path.sample(s)));
      boxes.push(bboxAround(pts, 25));
    }
    const seen = new Map<string, MapillaryImage>();
    const results = await Promise.all(boxes.map((b) => this.query(b, 500)));
    for (const img of results.flat()) seen.set(img.id, img);

    const candidates: (Candidate & { img: MapillaryImage })[] = [];
    for (const img of seen.values()) {
      const c = (img.computed_geometry ?? img.geometry)?.coordinates;
      if (!c || !img.thumb_2048_url) continue;
      const hit = path.project(path.projection.toLocal({ lat: c[1], lng: c[0] }));
      if (hit.distance > 10 || hit.s < from - 10 || hit.s > end + 10) continue;
      candidates.push({
        id: img.id,
        s: hit.s,
        offset: hit.distance,
        sequence: img.sequence ?? img.id,
        capturedAt: img.captured_at ?? 0,
        img,
      });
    }
    const picked = selectPanos(candidates, 6, this.lastSequence);
    if (picked.length) this.lastSequence = picked[picked.length - 1].sequence;
    return picked.map((c) => toPano((c as (typeof candidates)[number]).img));
  }

  firstLevel(quality: ImageryQuality): number {
    return quality === 'low' ? 1 : 2;
  }

  // 1 = 1024 px, 2 = 2048 px, 3 = the original upload (often 5K-8K wide).
  wantLevel(quality: ImageryQuality, distance: number, maxTextureSize: number): number {
    if (quality === 'ultra' && distance < 15 && maxTextureSize >= 4096) return 3;
    return quality === 'low' ? 1 : 2;
  }

  async load(pano: PanoInfo, level: number, maxTextureSize: number): Promise<HTMLCanvasElement> {
    const img = pano.data as MapillaryImage;
    const url =
      (level >= 3 && img.thumb_original_url) ||
      (level >= 2 && img.thumb_2048_url) ||
      img.thumb_1024_url ||
      img.thumb_2048_url!;
    const image = await loadImage(url);
    const canvas = document.createElement('canvas');
    // Equirectangular images are 2:1; clamp to what the GPU can hold.
    canvas.width = Math.min(image.naturalWidth, maxTextureSize);
    canvas.height = Math.min(Math.round(canvas.width / 2), maxTextureSize / 2);
    canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  async coverage(points: LatLng[]): Promise<number> {
    const picks = samplePoints(points, 20);
    const hits = await Promise.all(
      picks.map((p) =>
        this.query(bboxAround([p], 30), 1, 'id')
          .then((d) => d.length > 0)
          .catch(() => false),
      ),
    );
    return hits.filter(Boolean).length / Math.max(1, picks.length);
  }
}

function toPano(img: MapillaryImage): PanoInfo {
  const [lng, lat] = (img.computed_geometry ?? img.geometry)!.coordinates;
  const date = img.captured_at ? new Date(img.captured_at).toISOString().slice(0, 7) : '';
  const who = img.creator?.username ? `@${img.creator.username}` : '';
  return {
    id: img.id,
    lat,
    lng,
    // The centre column of a Mapillary panorama faces the camera's compass angle.
    heading: img.computed_compass_angle ?? img.compass_angle ?? 0,
    height: 2.0,
    attribution: [who, date].filter(Boolean).join(' · '),
    data: img,
  };
}

/** [west, south, east, north] around points, padded by `padM` metres. */
export function bboxAround(points: LatLng[], padM: number): [number, number, number, number] {
  const proj = new LocalProjection(points[0]);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    const v = proj.toLocal(p);
    minX = Math.min(minX, v.x);
    minY = Math.min(minY, v.y);
    maxX = Math.max(maxX, v.x);
    maxY = Math.max(maxY, v.y);
  }
  const sw = proj.toLatLng({ x: minX - padM, y: minY - padM });
  const ne = proj.toLatLng({ x: maxX + padM, y: maxY + padM });
  return [sw.lng, sw.lat, ne.lng, ne.lat];
}
