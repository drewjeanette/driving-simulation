import { loadGoogleMaps } from './providers/google/loader';
import { GooglePlanner } from './providers/google/map';
import { GooglePlacesSearch } from './providers/google/places';
import { GoogleRouting } from './providers/google/routes';
import { GoogleStreetViewSource, StreetViewTiles } from './providers/google/streetview';
import { PanoSource } from './providers/imagery';
import { MapillarySource, isPlausibleMapillaryToken } from './providers/mapillary';
import { OsrmRouting } from './providers/open/osrm';
import { PhotonSearch } from './providers/open/photon';
import { Providers } from './providers/types';

const GOOGLE_KEY_STORAGE = 'drive-sim:google-key';
const MAPILLARY_KEY_STORAGE = 'drive-sim:mapillary-token';

/** A Google Maps key looks like "AIza" + 35 URL-safe characters. */
export function isPlausibleKey(key: string): boolean {
  return /^AIza[0-9A-Za-z_-]{35}$/.test(key.trim());
}

function readStorage(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function writeStorage(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(key, value.trim());
    else localStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}

export const getStoredKey = () => readStorage(GOOGLE_KEY_STORAGE);
export const setStoredKey = (k: string) => writeStorage(GOOGLE_KEY_STORAGE, k);
export const getStoredMapillaryToken = () => readStorage(MAPILLARY_KEY_STORAGE);
export const setStoredMapillaryToken = (t: string) => writeStorage(MAPILLARY_KEY_STORAGE, t);

export interface Credentials {
  googleKey: string;
  mapillaryToken: string;
}

/**
 * Resolves imagery credentials, each in priority order:
 *  1. a value the user pasted into Settings (kept in this browser only),
 *  2. `config.json` deployed next to index.html (lets a host inject it at
 *     deploy time without it ever living in git),
 *  3. VITE_* variables from a local .env file for development.
 * Anything malformed is ignored.
 */
export async function resolveCredentials(): Promise<Credentials> {
  let cfg: { googleMapsApiKey?: unknown; mapillaryToken?: unknown } = {};
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}config.json`, { cache: 'no-store' });
    if (res.ok && (res.headers.get('content-type') ?? '').includes('json')) cfg = await res.json();
  } catch {
    /* no runtime config deployed */
  }
  const pick = (valid: (v: string) => boolean, ...values: unknown[]) =>
    (values.find((v) => typeof v === 'string' && valid(v)) as string | undefined)?.trim() ?? '';
  return {
    googleKey: pick(
      isPlausibleKey,
      getStoredKey(),
      cfg.googleMapsApiKey,
      import.meta.env.VITE_GOOGLE_MAPS_API_KEY,
    ),
    mapillaryToken: pick(
      isPlausibleMapillaryToken,
      getStoredMapillaryToken(),
      cfg.mapillaryToken,
      import.meta.env.VITE_MAPILLARY_TOKEN,
    ),
  };
}

export interface AppProviders extends Providers {
  /** Street-level 360° imagery, or null to drive the simulated road only. */
  imagery: PanoSource | null;
}

/**
 * Google is used when a working key is configured (and not switched off);
 * otherwise OpenStreetMap data, with free Mapillary imagery when a token is
 * available.
 */
export async function createProviders(preferOpen = false): Promise<AppProviders> {
  const { googleKey, mapillaryToken } = await resolveCredentials();
  const osrm = new OsrmRouting();
  if (googleKey && !preferOpen) {
    try {
      await loadGoogleMaps(googleKey);
      return {
        mode: 'google',
        search: new GooglePlacesSearch(),
        routing: new GoogleRouting(osrm),
        createMap: (el, o) => GooglePlanner.create(el, o),
        imagery: new GoogleStreetViewSource(new StreetViewTiles(googleKey)),
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
    imagery: mapillaryToken ? new MapillarySource(mapillaryToken) : null,
  };
}
