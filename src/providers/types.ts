import { LatLng } from '../geo/geo';
import { RouteData } from '../geo/route';

export interface Place {
  label: string;
  location: LatLng;
}

export interface PlaceSuggestion {
  id: string;
  primary: string;
  secondary: string;
  resolve(): Promise<Place>;
}

export interface SearchProvider {
  suggest(query: string, near?: LatLng): Promise<PlaceSuggestion[]>;
  /** Human-readable name for a clicked point. Falls back to coordinates. */
  reverse(point: LatLng): Promise<string>;
}

export interface RoutingProvider {
  route(from: LatLng, to: LatLng): Promise<RouteData>;
}

export interface PlannerMap {
  setView(center: LatLng, zoom: number, animate?: boolean): void;
  onClick(fn: (p: LatLng) => void): void;
  setMarkers(start: LatLng | null, end: LatLng | null): void;
  setRoute(points: LatLng[] | null): void;
  /** Car marker for the in-drive minimap. */
  setCar(p: LatLng | null, headingDeg?: number): void;
  resize(): void;
  destroy(): void;
}

export interface MapOptions {
  interactive: boolean;
  /** Minimaps follow the car and stay out of the way. */
  minimal?: boolean;
}

export type ProviderMode = 'google' | 'open';

export interface Providers {
  mode: ProviderMode;
  search: SearchProvider;
  routing: RoutingProvider;
  createMap(el: HTMLElement, options: MapOptions): Promise<PlannerMap>;
}

export function formatLatLng(p: LatLng): string {
  return `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
}

/** fetch() with a timeout, so a slow provider fails visibly instead of hanging. */
export async function fetchJson<T>(
  url: string,
  init: RequestInit = {},
  timeoutMs = 12_000,
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      signal: ctrl.signal,
      referrerPolicy: 'strict-origin-when-cross-origin',
    });
    if (!res.ok) {
      let detail = '';
      try {
        const body = (await res.json()) as { error?: { message?: string }; message?: string };
        detail = body.error?.message ?? body.message ?? '';
      } catch {
        /* non-JSON error body */
      }
      throw new Error(`${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}
