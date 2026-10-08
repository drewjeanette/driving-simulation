import { LocalProjection } from '../geo/geo';
import { RouteData } from '../geo/route';

const origin = { lat: 36.16, lng: -86.78 };

/** An L-shaped route: 300 m north, then a right turn and 200 m east. */
export function lRoute(): RouteData {
  const proj = new LocalProjection(origin);
  const corner = proj.toLatLng({ x: 0, y: 300 });
  const end = proj.toLatLng({ x: 200, y: 300 });
  return {
    source: 'osrm',
    points: [origin, corner, end],
    distanceMeters: 500,
    durationSeconds: 60,
    steps: [
      { instruction: 'Head north', maneuver: 'depart', location: origin, distanceMeters: 300 },
      { instruction: 'Turn right', maneuver: 'turn-right', location: corner, distanceMeters: 200 },
      { instruction: 'Arrive', maneuver: 'arrive', location: end, distanceMeters: 0 },
    ],
    speedLimits: [{ from: 0, to: 2, metersPerSecond: 13.4 }],
    attribution: 'test',
  };
}

export function straightRoute(lengthM = 2000): RouteData {
  const proj = new LocalProjection(origin);
  const end = proj.toLatLng({ x: 0, y: lengthM });
  return {
    source: 'osrm',
    points: [origin, end],
    distanceMeters: lengthM,
    durationSeconds: 100,
    steps: [],
    speedLimits: [],
    attribution: 'test',
  };
}
