import { LatLng } from '../../geo/geo';
import { Maneuver, RouteData, RouteStep, SpeedLimitSpan } from '../../geo/route';
import { RoutingProvider, fetchJson } from '../types';

const OSRM_URL = 'https://router.project-osrm.org/route/v1/driving';

interface OsrmStep {
  name: string;
  distance: number;
  maneuver: { type: string; modifier?: string; location: [number, number]; exit?: number };
}

type OsrmMaxspeed = { speed: number; unit: string } | { none: true } | { unknown: true };

export interface OsrmResponse {
  code: string;
  message?: string;
  routes: {
    distance: number;
    duration: number;
    geometry: { coordinates: [number, number][] };
    legs: { steps: OsrmStep[]; annotation?: { maxspeed?: OsrmMaxspeed[] } }[];
  }[];
}

export function osrmManeuver(type: string, modifier?: string): Maneuver {
  if (type === 'depart') return 'depart';
  if (type === 'arrive') return 'arrive';
  if (type === 'roundabout' || type === 'rotary' || type === 'roundabout turn') return 'roundabout';
  if (type === 'merge') return 'merge';
  if (type === 'fork') return modifier?.includes('left') ? 'fork-left' : 'fork-right';
  if (type === 'on ramp' || type === 'off ramp') {
    return modifier?.includes('left') ? 'ramp-left' : 'ramp-right';
  }
  switch (modifier) {
    case 'left':
      return 'turn-left';
    case 'right':
      return 'turn-right';
    case 'slight left':
      return 'slight-left';
    case 'slight right':
      return 'slight-right';
    case 'sharp left':
      return 'sharp-left';
    case 'sharp right':
      return 'sharp-right';
    case 'uturn':
      return 'uturn';
    case 'straight':
      return 'straight';
    default:
      return 'other';
  }
}

export function osrmInstruction(step: OsrmStep): string {
  const { type, modifier, exit } = step.maneuver;
  const onto = step.name ? ` onto ${step.name}` : '';
  switch (type) {
    case 'depart':
      return step.name ? `Head out on ${step.name}` : 'Start driving';
    case 'arrive':
      return 'You have arrived at your destination';
    case 'roundabout':
    case 'rotary':
      return `At the roundabout, take exit ${exit ?? 1}${onto}`;
    case 'merge':
      return `Merge${onto}`;
    case 'on ramp':
      return `Take the ramp${onto}`;
    case 'off ramp':
      return `Take the exit${onto}`;
    case 'fork':
      return `Keep ${modifier?.includes('left') ? 'left' : 'right'} at the fork${onto}`;
    case 'continue':
    case 'new name':
      return `Continue${onto || ' straight'}`;
    case 'end of road':
      return `At the end of the road, turn ${modifier ?? ''}${onto}`.replace('  ', ' ');
    default:
      if (modifier === 'uturn') return `Make a U-turn${onto}`;
      if (modifier === 'straight') return `Continue straight${onto}`;
      return `Turn ${modifier ?? ''}${onto}`.replace('  ', ' ');
  }
}

export function toMetersPerSecond(m: OsrmMaxspeed): number | null {
  if (!('speed' in m)) return null;
  return m.unit === 'mph' ? m.speed * 0.44704 : m.speed / 3.6;
}

/** Collapses per-segment speed limits into spans. Exported for tests. */
export function speedSpans(maxspeed: OsrmMaxspeed[]): SpeedLimitSpan[] {
  const spans: SpeedLimitSpan[] = [];
  maxspeed.forEach((m, i) => {
    const mps = toMetersPerSecond(m);
    if (mps === null) return;
    const last = spans[spans.length - 1];
    if (last && last.to === i && Math.abs(last.metersPerSecond - mps) < 0.01) last.to = i + 1;
    else spans.push({ from: i, to: i + 1, metersPerSecond: mps });
  });
  return spans;
}

export function parseOsrm(body: OsrmResponse): RouteData {
  if (body.code !== 'Ok' || !body.routes?.length) {
    throw new Error(body.message || 'No drivable route found between those points.');
  }
  const r = body.routes[0];
  const points = r.geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
  const steps: RouteStep[] = [];
  const maxspeed: OsrmMaxspeed[] = [];
  for (const leg of r.legs) {
    for (const s of leg.steps) {
      steps.push({
        instruction: osrmInstruction(s),
        maneuver: osrmManeuver(s.maneuver.type, s.maneuver.modifier),
        location: { lat: s.maneuver.location[1], lng: s.maneuver.location[0] },
        distanceMeters: s.distance,
      });
    }
    maxspeed.push(...(leg.annotation?.maxspeed ?? []));
  }
  return {
    source: 'osrm',
    points,
    distanceMeters: r.distance,
    durationSeconds: r.duration,
    steps,
    speedLimits: speedSpans(maxspeed),
    attribution: 'Routing © OSRM, data © OpenStreetMap contributors',
  };
}

/** Routing on OpenStreetMap data via the public OSRM demo server (no key). */
export class OsrmRouting implements RoutingProvider {
  constructor(private readonly baseUrl = OSRM_URL) {}

  async route(from: LatLng, to: LatLng): Promise<RouteData> {
    const coords = `${from.lng.toFixed(6)},${from.lat.toFixed(6)};${to.lng.toFixed(6)},${to.lat.toFixed(6)}`;
    const url = `${this.baseUrl}/${coords}?overview=full&geometries=geojson&steps=true&annotations=maxspeed`;
    return parseOsrm(await fetchJson<OsrmResponse>(url));
  }
}
