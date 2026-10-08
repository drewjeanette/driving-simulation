import { LatLng } from '../geo/geo';
import { DrivePath } from '../geo/path';

export type ImageryQuality = 'low' | 'high' | 'ultra';

/** One 360° equirectangular photo, wherever it came from. */
export interface PanoInfo {
  id: string;
  lat: number;
  lng: number;
  /** Compass heading (degrees) of the centre column of the image. */
  heading: number;
  /** Camera height above the road, metres. */
  height: number;
  /** Per-photo credit, e.g. capture date and photographer. */
  attribution: string;
  /** Source-specific extras (tile metadata, image URLs). */
  data?: unknown;
}

/**
 * A provider of street-level 360° imagery. The renderer only knows this
 * interface, so Google Street View and Mapillary are interchangeable.
 */
export interface PanoSource {
  /** Shown in the UI, e.g. "Google Street View". */
  readonly name: string;
  /** Credit line the provider requires next to its imagery. */
  readonly credit: string;
  /** Shown once if the source keeps failing. */
  readonly unavailableMessage: string;
  /** Panoramas along the route between distances `from` and `to` (metres). */
  discover(path: DrivePath, from: number, to: number): Promise<PanoInfo[]>;
  /** Resolution level to load first, so something appears quickly. */
  firstLevel(quality: ImageryQuality): number;
  /** Resolution level wanted for a pano `distance` metres from the car. */
  wantLevel(quality: ImageryQuality, distance: number, maxTextureSize: number): number;
  /** Loads a pano as an equirectangular image at a resolution level. */
  load(pano: PanoInfo, level: number, maxTextureSize: number): Promise<HTMLCanvasElement>;
  /** Fraction (0..1) of a route that has imagery, from a sample of points. */
  coverage(points: LatLng[]): Promise<number>;
}

export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.referrerPolicy = 'strict-origin-when-cross-origin';
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Panorama image failed to load'));
    img.src = url;
  });
}

/** Evenly spaced picks from a list of route points. */
export function samplePoints(points: LatLng[], n: number): LatLng[] {
  if (points.length <= n) return points.slice();
  const out: LatLng[] = [];
  for (let i = 0; i < n; i++) out.push(points[Math.round((i / (n - 1)) * (points.length - 1))]);
  return out;
}
