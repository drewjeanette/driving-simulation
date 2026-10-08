import { LatLng } from '../../geo/geo';
import { PlaceSuggestion, SearchProvider, formatLatLng } from '../types';

/** Address search with Places API (New) autocomplete, billed per session. */
export class GooglePlacesSearch implements SearchProvider {
  private token: google.maps.places.AutocompleteSessionToken | null = null;
  private geocoder: google.maps.Geocoder | null = null;

  async suggest(query: string, near?: LatLng): Promise<PlaceSuggestion[]> {
    const q = query.trim();
    if (q.length < 3) return [];
    const { AutocompleteSuggestion, AutocompleteSessionToken } = (await google.maps.importLibrary(
      'places',
    )) as google.maps.PlacesLibrary;
    this.token ??= new AutocompleteSessionToken();
    const request: google.maps.places.AutocompleteRequest = { input: q, sessionToken: this.token };
    if (near) request.locationBias = { center: near, radius: 50_000 };
    const { suggestions } = await AutocompleteSuggestion.fetchAutocompleteSuggestions(request);
    return suggestions
      .map((s) => s.placePrediction)
      .filter((p): p is google.maps.places.PlacePrediction => !!p)
      .map((p) => ({
        id: p.placeId,
        primary: p.mainText?.toString() ?? p.text.toString(),
        secondary: p.secondaryText?.toString() ?? '',
        resolve: async () => {
          const place = p.toPlace();
          await place.fetchFields({ fields: ['location', 'formattedAddress', 'displayName'] });
          // A selection ends the billing session; start a fresh one next time.
          this.token = null;
          if (!place.location) throw new Error('That place has no location.');
          return {
            label: place.formattedAddress ?? place.displayName ?? p.text.toString(),
            location: { lat: place.location.lat(), lng: place.location.lng() },
          };
        },
      }));
  }

  async reverse(point: LatLng): Promise<string> {
    try {
      const { Geocoder } = (await google.maps.importLibrary(
        'geocoding',
      )) as google.maps.GeocodingLibrary;
      this.geocoder ??= new Geocoder();
      const { results } = await this.geocoder.geocode({ location: point });
      return results[0]?.formatted_address ?? formatLatLng(point);
    } catch {
      return formatLatLng(point);
    }
  }
}
