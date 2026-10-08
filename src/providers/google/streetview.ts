import { LatLng } from '../../geo/geo';
import { DrivePath } from '../../geo/path';
import { ImageryQuality, PanoInfo, PanoSource, loadImage, samplePoints } from '../imagery';
import { fetchJson } from '../types';

/**
 * Client for the Street View endpoints of the Google Map Tiles API. Unlike
 * the embedded StreetViewPanorama widget, raw tiles let the app render the
 * imagery itself in WebGL, which is what makes smooth motion between
 * panoramas and WebXR (VR headset) rendering possible.
 *
 * https://developers.google.com/maps/documentation/tile/streetview
 */
const BASE = 'https://tile.googleapis.com/v1';

export interface PanoMetadata {
  panoId: string;
  lat: number;
  lng: number;
  /** Compass heading of the image centre, degrees. */
  heading: number;
  tilt?: number;
  roll?: number;
  imageWidth: number;
  imageHeight: number;
  tileWidth: number;
  tileHeight: number;
  date?: string;
  copyright?: string;
}

interface Session {
  session: string;
  expiry: string;
}

export class StreetViewTiles {
  private session: Promise<string> | null = null;

  constructor(private readonly apiKey: string) {}

  private async token(): Promise<string> {
    this.session ??= fetchJson<Session>(
      `${BASE}/createSession?key=${encodeURIComponent(this.apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mapType: 'streetview',
          language: navigator.language || 'en-US',
          region: 'US',
        }),
      },
    ).then((s) => s.session);
    this.session.catch(() => (this.session = null));
    return this.session;
  }

  private async query(): Promise<string> {
    const session = await this.token();
    return `session=${encodeURIComponent(session)}&key=${encodeURIComponent(this.apiKey)}`;
  }

  /** Nearest panorama for each location (empty string where there is none). Max 100 per call. */
  async panoIds(locations: LatLng[], radius = 25): Promise<string[]> {
    const body = await fetchJson<{ panoIds: string[] }>(
      `${BASE}/streetview/panoIds?${await this.query()}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          locations: locations.map(({ lat, lng }) => ({ lat, lng })),
          radius,
        }),
      },
    );
    return body.panoIds ?? [];
  }

  /** Fraction (0..1) of sample points along a route that have a panorama nearby. */
  async coverage(points: LatLng[], samples = 60): Promise<number> {
    if (!points.length) return 0;
    const picks = samplePoints(points, samples);
    const ids = await this.panoIds(picks, 30);
    return ids.filter(Boolean).length / picks.length;
  }

  async metadata(panoId: string): Promise<PanoMetadata> {
    return fetchJson<PanoMetadata>(
      `${BASE}/streetview/metadata?${await this.query()}&panoId=${encodeURIComponent(panoId)}`,
    );
  }

  async tileUrl(panoId: string, z: number, x: number, y: number): Promise<string> {
    return `${BASE}/streetview/tiles/${z}/${x}/${y}?${await this.query()}&panoId=${encodeURIComponent(panoId)}`;
  }
}

/**
 * Tile grid for a panorama at a zoom level. The highest zoom (5) has the
 * image at full resolution; each lower level halves it. Edge tiles can be
 * partly padding, so the visible image size is returned separately.
 */
export function tileGrid(
  meta: Pick<PanoMetadata, 'imageWidth' | 'imageHeight' | 'tileWidth' | 'tileHeight'>,
  z: number,
) {
  const tw = meta.tileWidth || 512;
  const th = meta.tileHeight || 512;
  const maxZoom = Math.max(0, Math.ceil(Math.log2(meta.imageWidth / tw)));
  const scale = 2 ** Math.max(0, maxZoom - z);
  const width = Math.max(1, Math.round(meta.imageWidth / scale));
  const height = Math.max(1, Math.round(meta.imageHeight / scale));
  return {
    cols: Math.ceil(width / tw),
    rows: Math.ceil(height / th),
    width,
    height,
    tileWidth: tw,
    tileHeight: th,
  };
}

/** Google Street View as a PanoSource for the renderer. */
export class GoogleStreetViewSource implements PanoSource {
  readonly name = 'Google Street View';
  readonly credit = 'Imagery © Google';
  readonly unavailableMessage =
    'Street View imagery is unavailable (the Map Tiles API may not be enabled for this key). Showing the simulated road instead.';
  private readonly known = new Set<string>();

  constructor(private readonly tiles: StreetViewTiles) {}

  async discover(path: DrivePath, from: number, to: number): Promise<PanoInfo[]> {
    const locations: LatLng[] = [];
    for (let at = from; at <= Math.min(to, path.length) && locations.length < 100; at += 10) {
      locations.push(path.toLatLng(path.sample(at)));
    }
    const ids = (await this.tiles.panoIds(locations, 20)).filter((id) => id && !this.known.has(id));
    ids.forEach((id) => this.known.add(id));
    const out: PanoInfo[] = [];
    // A few metadata requests at a time keeps the browser's connection pool free for tiles.
    for (let i = 0; i < ids.length; i += 4) {
      const metas = await Promise.all(ids.slice(i, i + 4).map((id) => this.tiles.metadata(id)));
      for (const m of metas) {
        out.push({
          id: m.panoId,
          lat: m.lat,
          lng: m.lng,
          heading: m.heading,
          height: 2.5,
          attribution: [m.copyright, m.date].filter(Boolean).join(' · '),
          data: m,
        });
      }
    }
    return out;
  }

  firstLevel(): number {
    return 2;
  }

  // Zoom 2 is 2K, zoom 3 is 4K and zoom 4 is 8K across the full 360°.
  wantLevel(quality: ImageryQuality, distance: number, maxTextureSize: number): number {
    if (quality === 'ultra' && distance < 15 && maxTextureSize >= 8192) return 4;
    if (quality !== 'low' && distance < 35) return 3;
    return 2;
  }

  async load(pano: PanoInfo, z: number, maxTextureSize: number): Promise<HTMLCanvasElement> {
    const meta = pano.data as PanoMetadata;
    const grid = tileGrid(meta, z);
    const canvas = document.createElement('canvas');
    canvas.width = Math.min(grid.width, maxTextureSize);
    canvas.height = Math.min(grid.height, maxTextureSize / 2);
    const ctx = canvas.getContext('2d')!;
    const sx = canvas.width / grid.width;
    const sy = canvas.height / grid.height;
    const jobs: Promise<void>[] = [];
    for (let y = 0; y < grid.rows; y++) {
      for (let x = 0; x < grid.cols; x++) {
        jobs.push(
          this.tiles
            .tileUrl(pano.id, z, x, y)
            .then(loadImage)
            .then((img) => {
              const w = grid.tileWidth * sx;
              const h = grid.tileHeight * sy;
              ctx.drawImage(img, x * w, y * h, w, h);
            }),
        );
      }
    }
    await Promise.all(jobs);
    return canvas;
  }

  coverage(points: LatLng[]): Promise<number> {
    return this.tiles.coverage(points);
  }
}
