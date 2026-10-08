import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre 6 loads its worker from a file next to its own module; once bundled
// that file has to be emitted separately and pointed at explicitly.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { LatLng } from '../../geo/geo';
import { MapOptions, PlannerMap } from '../types';
import { markerElement, carElement, routePadding } from '../markers';

// OpenFreeMap: free vector tiles from OpenStreetMap, no key or sign-up.
const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

maplibregl.setWorkerUrl(workerUrl);

const ll = (p: LatLng): [number, number] => [p.lng, p.lat];

export class MapLibrePlanner implements PlannerMap {
  private readonly map: maplibregl.Map;
  private readonly ready: Promise<void>;
  private start?: maplibregl.Marker;
  private end?: maplibregl.Marker;
  private car?: maplibregl.Marker;
  private readonly minimal: boolean;

  constructor(el: HTMLElement, options: MapOptions) {
    this.minimal = !!options.minimal;
    this.map = new maplibregl.Map({
      container: el,
      style: STYLE_URL,
      center: [-40, 30],
      zoom: options.minimal ? 15 : 1.4,
      interactive: options.interactive,
      attributionControl: { compact: true },
      maxPitch: 60,
    });
    if (!options.minimal) this.map.addControl(new maplibregl.NavigationControl(), 'bottom-right');
    this.ready = new Promise((resolve) => {
      this.map.on('style.load', () => {
        // Zoomed out it's a globe; zooming in blends smoothly into a flat map.
        if (!options.minimal) this.map.setProjection({ type: 'globe' });
        this.map.addSource('route', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        });
        this.map.addLayer({
          id: 'route-casing',
          type: 'line',
          source: 'route',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#0b3d91', 'line-width': 9, 'line-opacity': 0.55 },
        });
        this.map.addLayer({
          id: 'route-line',
          type: 'line',
          source: 'route',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#3b82f6', 'line-width': 5 },
        });
        resolve();
      });
    });
  }

  static async create(el: HTMLElement, options: MapOptions): Promise<MapLibrePlanner> {
    const m = new MapLibrePlanner(el, options);
    await m.ready;
    return m;
  }

  setView(center: LatLng, zoom: number, animate = true): void {
    if (animate) this.map.flyTo({ center: ll(center), zoom, speed: 1.6, essential: true });
    else this.map.jumpTo({ center: ll(center), zoom });
  }

  onClick(fn: (p: LatLng) => void): void {
    this.map.on('click', (e) => fn({ lat: e.lngLat.lat, lng: e.lngLat.lng }));
  }

  setMarkers(start: LatLng | null, end: LatLng | null): void {
    this.start = this.place(this.start, start, 'A');
    this.end = this.place(this.end, end, 'B');
  }

  private place(m: maplibregl.Marker | undefined, p: LatLng | null, label: 'A' | 'B') {
    if (!p) {
      m?.remove();
      return undefined;
    }
    if (m) return m.setLngLat(ll(p));
    return new maplibregl.Marker({ element: markerElement(label), anchor: 'bottom' })
      .setLngLat(ll(p))
      .addTo(this.map);
  }

  setRoute(points: LatLng[] | null): void {
    void this.ready.then(() => {
      const src = this.map.getSource('route') as maplibregl.GeoJSONSource | undefined;
      src?.setData({
        type: 'FeatureCollection',
        features: points
          ? [
              {
                type: 'Feature',
                properties: {},
                geometry: { type: 'LineString', coordinates: points.map(ll) },
              },
            ]
          : [],
      });
      if (points && points.length > 1 && !this.minimal) {
        const b = new maplibregl.LngLatBounds();
        points.forEach((p) => b.extend(ll(p)));
        this.map.fitBounds(b, { padding: routePadding(), duration: 900, maxZoom: 16 });
      }
    });
  }

  setCar(p: LatLng | null, headingDeg = 0): void {
    if (!p) {
      this.car?.remove();
      this.car = undefined;
      return;
    }
    if (!this.car) {
      this.car = new maplibregl.Marker({ element: carElement(), rotationAlignment: 'map' })
        .setLngLat(ll(p))
        .addTo(this.map);
    }
    this.car.setLngLat(ll(p)).setRotation(headingDeg);
    this.map.jumpTo({ center: ll(p), bearing: headingDeg });
  }

  resize(): void {
    this.map.resize();
  }

  destroy(): void {
    this.map.remove();
  }
}
