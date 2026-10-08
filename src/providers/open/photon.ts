import { LatLng } from '../../geo/geo';
import { PlaceSuggestion, SearchProvider, fetchJson, formatLatLng } from '../types';

const PHOTON_URL = 'https://photon.komoot.io';

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: {
    osm_id?: number;
    name?: string;
    housenumber?: string;
    street?: string;
    city?: string;
    district?: string;
    state?: string;
    country?: string;
    postcode?: string;
  };
}

export function photonLabel(p: PhotonFeature['properties']): {
  primary: string;
  secondary: string;
} {
  const street = [p.housenumber, p.street].filter(Boolean).join(' ');
  const primary = p.name || street || p.city || p.state || p.country || 'Unnamed place';
  const secondary = [p.name && street ? street : '', p.city ?? p.district, p.state, p.country]
    .filter((x) => x && x !== primary)
    .join(', ');
  return { primary, secondary };
}

/** Address search on OpenStreetMap data (Photon by komoot). Designed for autocomplete. */
export class PhotonSearch implements SearchProvider {
  constructor(private readonly baseUrl = PHOTON_URL) {}

  async suggest(query: string, near?: LatLng): Promise<PlaceSuggestion[]> {
    const q = query.trim();
    if (q.length < 3) return [];
    const params = new URLSearchParams({ q, limit: '6' });
    if (near) {
      params.set('lat', near.lat.toFixed(4));
      params.set('lon', near.lng.toFixed(4));
    }
    const body = await fetchJson<{ features: PhotonFeature[] }>(`${this.baseUrl}/api/?${params}`);
    return body.features.map((f, i) => {
      const { primary, secondary } = photonLabel(f.properties);
      const location = { lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] };
      return {
        id: `${f.properties.osm_id ?? i}`,
        primary,
        secondary,
        resolve: async () => ({ label: [primary, secondary].filter(Boolean).join(', '), location }),
      };
    });
  }

  async reverse(point: LatLng): Promise<string> {
    try {
      const params = new URLSearchParams({ lat: `${point.lat}`, lon: `${point.lng}` });
      const body = await fetchJson<{ features: PhotonFeature[] }>(
        `${this.baseUrl}/reverse?${params}`,
      );
      const f = body.features[0];
      if (!f) return formatLatLng(point);
      const { primary, secondary } = photonLabel(f.properties);
      return [primary, secondary].filter(Boolean).join(', ');
    } catch {
      return formatLatLng(point);
    }
  }
}
