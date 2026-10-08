import { LatLng } from './geo';

export type Maneuver =
  | 'depart'
  | 'straight'
  | 'turn-left'
  | 'turn-right'
  | 'slight-left'
  | 'slight-right'
  | 'sharp-left'
  | 'sharp-right'
  | 'uturn'
  | 'merge'
  | 'roundabout'
  | 'fork-left'
  | 'fork-right'
  | 'ramp-left'
  | 'ramp-right'
  | 'arrive'
  | 'other';

export interface RouteStep {
  /** Plain-text instruction. Always rendered with textContent, never as HTML. */
  instruction: string;
  maneuver: Maneuver;
  /** Where the manoeuvre happens. */
  location: LatLng;
  distanceMeters: number;
}

export interface SpeedLimitSpan {
  /** Index range into RouteData.points, inclusive start and exclusive end. */
  from: number;
  to: number;
  metersPerSecond: number;
}

export interface RouteData {
  source: 'google' | 'osrm';
  points: LatLng[];
  distanceMeters: number;
  durationSeconds: number;
  steps: RouteStep[];
  speedLimits: SpeedLimitSpan[];
  /** Attribution text required by the data provider. */
  attribution: string;
}

/** Manoeuvres the coach expects a turn signal for, and which side. */
export function signalFor(m: Maneuver): 'left' | 'right' | null {
  switch (m) {
    case 'turn-left':
    case 'sharp-left':
    case 'slight-left':
    case 'fork-left':
    case 'ramp-left':
    case 'uturn':
      return 'left';
    case 'turn-right':
    case 'sharp-right':
    case 'slight-right':
    case 'fork-right':
    case 'ramp-right':
      return 'right';
    default:
      return null;
  }
}

/** Short, friendly arrow glyph for the navigation banner. */
export function maneuverGlyph(m: Maneuver): string {
  switch (m) {
    case 'turn-left':
    case 'sharp-left':
      return '↰';
    case 'turn-right':
    case 'sharp-right':
      return '↱';
    case 'slight-left':
    case 'fork-left':
    case 'ramp-left':
      return '↖';
    case 'slight-right':
    case 'fork-right':
    case 'ramp-right':
      return '↗';
    case 'uturn':
      return '↶';
    case 'roundabout':
      return '⟳';
    case 'arrive':
      return '⚑';
    default:
      return '↑';
  }
}
