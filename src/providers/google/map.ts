import { LatLng } from '../../geo/geo';
import { MapOptions, PlannerMap } from '../types';

const PIN = (fill: string, label: string) =>
  `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="34" height="44" viewBox="0 0 34 44"><path d="M17 43C17 43 32 27 32 16A15 15 0 0 0 2 16C2 27 17 43 17 43Z" fill="${fill}" stroke="white" stroke-width="2.5"/><text x="17" y="21" font-family="system-ui,sans-serif" font-size="14" font-weight="700" text-anchor="middle" fill="white">${label}</text></svg>`,
  )}`;

export class GooglePlanner implements PlannerMap {
  private readonly map: google.maps.Map;
  private start?: google.maps.Marker;
  private end?: google.maps.Marker;
  private car?: google.maps.Marker;
  private line?: google.maps.Polyline;

  private constructor(el: HTMLElement, options: MapOptions) {
    this.map = new google.maps.Map(el, {
      center: { lat: 30, lng: -40 },
      zoom: options.minimal ? 17 : 2,
      disableDefaultUI: true,
      zoomControl: !options.minimal,
      gestureHandling: options.interactive ? 'greedy' : 'none',
      clickableIcons: false,
      keyboardShortcuts: false,
      isFractionalZoomEnabled: true,
      streetViewControl: false,
    });
  }

  static async create(el: HTMLElement, options: MapOptions): Promise<GooglePlanner> {
    await google.maps.importLibrary('maps');
    return new GooglePlanner(el, options);
  }

  setView(center: LatLng, zoom: number, animate = true): void {
    if (animate) {
      this.map.panTo(center);
      this.map.setZoom(zoom);
    } else {
      this.map.setCenter(center);
      this.map.setZoom(zoom);
    }
  }

  onClick(fn: (p: LatLng) => void): void {
    this.map.addListener('click', (e: google.maps.MapMouseEvent) => {
      if (e.latLng) fn({ lat: e.latLng.lat(), lng: e.latLng.lng() });
    });
  }

  setMarkers(start: LatLng | null, end: LatLng | null): void {
    this.start = this.place(this.start, start, PIN('#16a34a', 'A'));
    this.end = this.place(this.end, end, PIN('#dc2626', 'B'));
  }

  private place(m: google.maps.Marker | undefined, p: LatLng | null, icon: string) {
    if (!p) {
      m?.setMap(null);
      return undefined;
    }
    if (m) {
      m.setPosition(p);
      return m;
    }
    return new google.maps.Marker({
      map: this.map,
      position: p,
      icon: { url: icon, anchor: new google.maps.Point(17, 43) },
    });
  }

  setRoute(points: LatLng[] | null): void {
    this.line?.setMap(null);
    this.line = undefined;
    if (!points || points.length < 2) return;
    this.line = new google.maps.Polyline({
      map: this.map,
      path: points,
      strokeColor: '#3b82f6',
      strokeOpacity: 1,
      strokeWeight: 5,
    });
    const b = new google.maps.LatLngBounds();
    points.forEach((p) => b.extend(p));
    this.map.fitBounds(b, 80);
  }

  setCar(p: LatLng | null, headingDeg = 0): void {
    if (!p) {
      this.car?.setMap(null);
      this.car = undefined;
      return;
    }
    const icon: google.maps.Symbol = {
      path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
      scale: 6,
      fillColor: '#f59e0b',
      fillOpacity: 1,
      strokeColor: '#ffffff',
      strokeWeight: 2,
      rotation: headingDeg,
    };
    if (!this.car) this.car = new google.maps.Marker({ map: this.map, position: p, icon });
    else {
      this.car.setPosition(p);
      this.car.setIcon(icon);
    }
    this.map.setCenter(p);
  }

  resize(): void {
    /* Google Maps tracks container size itself. */
  }

  destroy(): void {
    this.setMarkers(null, null);
    this.setRoute(null);
    this.setCar(null);
  }
}
