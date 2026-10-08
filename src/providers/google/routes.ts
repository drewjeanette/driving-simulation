import { LatLng } from '../../geo/geo';
import { Maneuver, RouteData, RouteStep } from '../../geo/route';
import { RoutingProvider } from '../types';

/** Maps Routes API maneuver enums onto the app's manoeuvre set. */
export function googleManeuver(m: string | null | undefined): Maneuver {
  switch (m) {
    case 'DEPART':
      return 'depart';
    case 'TURN_LEFT':
      return 'turn-left';
    case 'TURN_RIGHT':
      return 'turn-right';
    case 'TURN_SLIGHT_LEFT':
      return 'slight-left';
    case 'TURN_SLIGHT_RIGHT':
      return 'slight-right';
    case 'TURN_SHARP_LEFT':
      return 'sharp-left';
    case 'TURN_SHARP_RIGHT':
      return 'sharp-right';
    case 'UTURN_LEFT':
    case 'UTURN_RIGHT':
      return 'uturn';
    case 'MERGE':
      return 'merge';
    case 'FORK_LEFT':
      return 'fork-left';
    case 'FORK_RIGHT':
      return 'fork-right';
    case 'RAMP_LEFT':
      return 'ramp-left';
    case 'RAMP_RIGHT':
      return 'ramp-right';
    case 'ROUNDABOUT_LEFT':
    case 'ROUNDABOUT_RIGHT':
      return 'roundabout';
    case 'STRAIGHT':
    case 'NAME_CHANGE':
      return 'straight';
    default:
      return 'other';
  }
}

/** Routing with the Routes library of the Maps JavaScript API. */
export class GoogleRouting implements RoutingProvider {
  constructor(private readonly fallback?: RoutingProvider) {}

  async route(from: LatLng, to: LatLng): Promise<RouteData> {
    try {
      return await this.compute(from, to);
    } catch (err) {
      if (!this.fallback) throw err;
      console.warn('Google routing failed, falling back to OSRM:', err);
      return this.fallback.route(from, to);
    }
  }

  private async compute(from: LatLng, to: LatLng): Promise<RouteData> {
    const { Route } = (await google.maps.importLibrary('routes')) as google.maps.RoutesLibrary;
    const { routes } = await Route.computeRoutes({
      origin: from,
      destination: to,
      travelMode: 'DRIVING',
      fields: ['path', 'legs', 'distanceMeters', 'durationMillis'],
    });
    const r = routes?.[0];
    if (!r?.path?.length) throw new Error('No drivable route found between those points.');
    const steps: RouteStep[] = [];
    for (const leg of r.legs ?? []) {
      for (const s of leg.steps) {
        const at = s.startLocation;
        if (!at) continue;
        steps.push({
          instruction: s.instructions ?? '',
          maneuver: googleManeuver(s.maneuver),
          location: { lat: at.lat, lng: at.lng },
          distanceMeters: s.distanceMeters,
        });
      }
    }
    const end = r.path[r.path.length - 1];
    steps.push({
      instruction: 'You have arrived at your destination',
      maneuver: 'arrive',
      location: { lat: end.lat, lng: end.lng },
      distanceMeters: 0,
    });
    return {
      source: 'google',
      points: r.path.map((p) => ({ lat: p.lat, lng: p.lng })),
      distanceMeters: r.distanceMeters ?? 0,
      durationSeconds: (r.durationMillis ?? 0) / 1000,
      steps,
      // Routes API doesn't expose posted limits; the coach skips speed checks.
      speedLimits: [],
      attribution: 'Route © Google',
    };
  }
}
