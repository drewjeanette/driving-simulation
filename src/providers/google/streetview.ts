import { LatLng } from '../../geo/geo';
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
    const picks: LatLng[] = [];
    for (let i = 0; i < samples; i++)
      picks.push(points[Math.round((i / (samples - 1)) * (points.length - 1))]);
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
