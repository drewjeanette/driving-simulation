import { loadGoogleMaps } from './providers/google/loader';
import { GooglePlanner } from './providers/google/map';
import { GooglePlacesSearch } from './providers/google/places';
import { GoogleRouting } from './providers/google/routes';
import { StreetViewTiles } from './providers/google/streetview';
import { OsrmRouting } from './providers/open/osrm';
import { PhotonSearch } from './providers/open/photon';
import { Providers } from './providers/types';

const KEY_STORAGE = 'drive-sim:google-key';

/** A Google Maps key looks like "AIza" + 35 URL-safe characters. */
export function isPlausibleKey(key: string): boolean {
  return /^AIza[0-9A-Za-z_-]{35}$/.test(key.trim());
}

export function getStoredKey(): string {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? '';
  } catch {
    return '';
  }
}

export function setStoredKey(key: string): void {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key.trim());
    else localStorage.removeItem(KEY_STORAGE);
  } catch {
    /* storage unavailable */
  }
}

/**
 * Resolves the Google Maps key, in priority order:
 *  1. a key the user pasted into Settings (kept in this browser only),
 *  2. `config.json` deployed next to index.html (lets a host inject a key at
 *     deploy time without it ever living in git),
 *  3. VITE_GOOGLE_MAPS_API_KEY from a local .env file for development.
 * No key means Open mode, which needs no account at all.
 */
export async function resolveGoogleKey(): Promise<string> {
  const stored = getStoredKey();
  if (isPlausibleKey(stored)) return stored;
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}config.json`, { cache: 'no-store' });
    if (res.ok && (res.headers.get('content-type') ?? '').includes('json')) {
      const cfg = (await res.json()) as { googleMapsApiKey?: unknown };
      if (typeof cfg.googleMapsApiKey === 'string' && isPlausibleKey(cfg.googleMapsApiKey)) {
        return cfg.googleMapsApiKey;
      }
    }
  } catch {
    /* no runtime config deployed */
  }
  const envKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY ?? '';
  return isPlausibleKey(envKey) ? envKey : '';
}

export interface AppProviders extends Providers {
  streetView: StreetViewTiles | null;
}

export async function createProviders(preferOpen = false): Promise<AppProviders> {
  const key = preferOpen ? '' : await resolveGoogleKey();
  const osrm = new OsrmRouting();
  if (key) {
    try {
      await loadGoogleMaps(key);
      return {
        mode: 'google',
        search: new GooglePlacesSearch(),
        routing: new GoogleRouting(osrm),
        createMap: (el, o) => GooglePlanner.create(el, o),
        streetView: new StreetViewTiles(key),
      };
    } catch (err) {
      console.warn('Google Maps unavailable, using Open mode:', err);
    }
  }
  return {
    mode: 'open',
    search: new PhotonSearch(),
    routing: osrm,
    // MapLibre is large, so it is only downloaded in Open mode.
    createMap: async (el, o) =>
      (await import('./providers/open/maplibre')).MapLibrePlanner.create(el, o),
    streetView: null,
  };
}
