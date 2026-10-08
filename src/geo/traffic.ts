import { LatLng } from './geo';

/**
 * Rough bounding boxes of the larger places that drive on the left. Good
 * enough to pick a sensible default; the setting can always override it.
 * [south, west, north, east]
 */
const LEFT_HAND: [number, number, number, number][] = [
  [49.8, -8.7, 60.9, 1.8], // United Kingdom
  [51.4, -10.6, 55.4, -5.9], // Ireland
  [24.0, 122.9, 45.6, 153.9], // Japan
  [-43.7, 112.9, -10.6, 153.7], // Australia
  [-47.4, 166.3, -34.3, 178.6], // New Zealand
  [6.7, 68.1, 35.5, 97.4], // India (approx.)
  [5.9, 79.6, 9.9, 81.9], // Sri Lanka
  [-34.9, 16.4, -22.1, 32.9], // South Africa
  [-11.0, 95.0, 6.1, 141.0], // Indonesia
  [0.8, 99.6, 7.4, 119.3], // Malaysia
  [5.6, 97.3, 20.5, 105.6], // Thailand
  [-4.7, 33.9, 5.0, 41.9], // Kenya
  [22.1, 113.8, 22.6, 114.4], // Hong Kong
  [1.2, 103.6, 1.5, 104.1], // Singapore
];

export function drivesOnLeft(p: LatLng): boolean {
  return LEFT_HAND.some(([s, w, n, e]) => p.lat >= s && p.lat <= n && p.lng >= w && p.lng <= e);
}
