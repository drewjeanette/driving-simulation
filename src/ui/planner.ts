import { LatLng, haversine } from '../geo/geo';
import { RouteData } from '../geo/route';
import { AppProviders } from '../config';
import { PlannerMap, formatLatLng } from '../providers/types';
import { Settings } from './settings';
import { SearchBox } from './searchbox';
import { el, icon, toast } from './dom';

export interface Endpoint {
  label: string;
  location: LatLng;
}

const MAX_ROUTE_M = 40_000;

/** Sample routes for people who just want to try it. Coordinates only, no stored pano IDs. */
export const SAMPLE_ROUTES: { name: string; from: Endpoint; to: Endpoint }[] = [
  {
    name: 'Suburban loop · Franklin, TN',
    from: { label: 'Main St, Franklin, TN', location: { lat: 35.92515, lng: -86.86849 } },
    to: { label: 'Hillsboro Rd, Franklin, TN', location: { lat: 35.93556, lng: -86.87913 } },
  },
  {
    name: 'City grid · San Francisco',
    from: { label: 'Market St & 5th St, SF', location: { lat: 37.78348, lng: -122.40841 } },
    to: { label: 'Union Square, SF', location: { lat: 37.78795, lng: -122.40752 } },
  },
  {
    name: 'Left-side driving · London',
    from: { label: 'Kensington High St, London', location: { lat: 51.50093, lng: -0.19253 } },
    to: { label: 'Holland Park Ave, London', location: { lat: 51.50735, lng: -0.20526 } },
  },
];

function fmtDistance(m: number, units: Settings['units']): string {
  return units === 'mph' ? `${(m / 1609.34).toFixed(1)} mi` : `${(m / 1000).toFixed(1)} km`;
}

function fmtDuration(s: number): string {
  const min = Math.max(1, Math.round(s / 60));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

/** Route planning: search or click to set A and B, preview the route, start driving. */
export class PlannerScreen {
  readonly root: HTMLElement;
  private map: PlannerMap | null = null;
  private from: Endpoint | null = null;
  private to: Endpoint | null = null;
  private route: RouteData | null = null;
  private readonly fromBox: SearchBox;
  private readonly toBox: SearchBox;
  private readonly summary: HTMLElement;
  private readonly startBtn: HTMLButtonElement;
  private readonly hint: HTMLElement;
  private seq = 0;
  onStart?: (route: RouteData, from: Endpoint, to: Endpoint) => void;
  onBack?: () => void;
  onSettings?: () => void;

  constructor(
    private readonly providers: AppProviders,
    private readonly settings: Settings,
  ) {
    this.fromBox = new SearchBox(providers.search, {
      label: 'Starting point',
      placeholder: 'Starting address',
      badge: 'A',
    });
    this.toBox = new SearchBox(providers.search, {
      label: 'Destination',
      placeholder: 'Destination address',
      badge: 'B',
    });
    this.fromBox.onSelect = (p) => this.setFrom(p, true);
    this.toBox.onSelect = (p) => this.setTo(p, true);
    this.toBox.near = this.fromBox.near = () => this.from?.location ?? this.to?.location;

    this.summary = el('div', { class: 'route-summary', 'aria-live': 'polite' });
    this.hint = el(
      'p',
      { class: 'planner-hint' },
      'Search for an address, or click the map to drop point A, then point B.',
    );
    this.startBtn = el(
      'button',
      { class: 'btn btn-primary btn-lg', disabled: true, onclick: () => this.start() },
      icon('play', 18),
      'Start driving',
    );

    const swap = el(
      'button',
      {
        class: 'icon-btn',
        title: 'Swap start and destination',
        'aria-label': 'Swap start and destination',
        onclick: () => this.swap(),
      },
      icon('swap', 16),
    );
    const locate = el(
      'button',
      { class: 'link-btn', onclick: () => this.useMyLocation() },
      icon('locate', 15),
      'Use my location',
    );

    const samples = el(
      'div',
      { class: 'samples' },
      el('p', { class: 'eyebrow' }, 'Or try a sample route'),
      ...SAMPLE_ROUTES.map((r) =>
        el(
          'button',
          {
            class: 'sample',
            onclick: () => {
              this.setFrom(r.from, false);
              this.setTo(r.to, false);
            },
          },
          icon('route', 15),
          r.name,
        ),
      ),
    );

    const mapHost = el('div', { class: 'planner-map', id: 'planner-map' });
    const panel = el(
      'aside',
      { class: 'planner-panel glass' },
      el(
        'header',
        { class: 'planner-head' },
        el(
          'button',
          {
            class: 'icon-btn',
            'aria-label': 'Back to home',
            title: 'Back',
            onclick: () => this.onBack?.(),
          },
          icon('back', 16),
        ),
        el('h1', {}, 'Plan your practice drive'),
        el(
          'button',
          {
            class: 'icon-btn',
            'aria-label': 'Settings',
            title: 'Settings',
            onclick: () => this.onSettings?.(),
          },
          icon('settings', 16),
        ),
      ),
      el('div', { class: 'route-inputs' }, this.fromBox.root, swap, this.toBox.root),
      locate,
      this.hint,
      this.summary,
      this.startBtn,
      samples,
      el(
        'p',
        { class: 'mode-note' },
        providers.mode === 'google'
          ? 'Google Maps mode · Street View imagery where available'
          : providers.imagery
            ? 'Free mode · OpenStreetMap + Mapillary 360° imagery'
            : 'Open mode · OpenStreetMap data with a simulated road',
      ),
    );
    this.root = el('section', { class: 'screen planner' }, mapHost, panel);
  }

  async mount(initial?: LatLng): Promise<void> {
    const host = this.root.querySelector<HTMLElement>('#planner-map')!;
    try {
      this.map = await this.providers.createMap(host, { interactive: true });
    } catch (err) {
      toast(`The map failed to load: ${(err as Error).message}`, 'error');
      return;
    }
    this.map.onClick((p) => void this.onMapClick(p));
    if (initial) this.map.setView(initial, 14, false);
    if (this.from || this.to) this.refresh();
  }

  /** Pre-fills the start from the globe or the landing search. */
  async presetStart(p: LatLng, label?: string): Promise<void> {
    this.setFrom({ label: label ?? formatLatLng(p), location: p }, false);
    this.map?.setView(p, 15);
    if (!label) {
      const name = await this.providers.search.reverse(p);
      if (this.from?.location === p) {
        this.from.label = name;
        this.fromBox.setValue(name);
      }
    }
  }

  private async onMapClick(p: LatLng): Promise<void> {
    const target = !this.from ? 'from' : !this.to ? 'to' : 'to';
    const ep = { label: formatLatLng(p), location: p };
    if (target === 'from') this.setFrom(ep, false);
    else this.setTo(ep, false);
    const name = await this.providers.search.reverse(p);
    const cur = target === 'from' ? this.from : this.to;
    if (cur?.location === p) {
      cur.label = name;
      (target === 'from' ? this.fromBox : this.toBox).setValue(name);
    }
  }

  private setFrom(p: Endpoint, fly: boolean): void {
    this.from = p;
    this.fromBox.setValue(p.label);
    if (fly && !this.to) this.map?.setView(p.location, 15);
    this.refresh();
  }

  private setTo(p: Endpoint, fly: boolean): void {
    this.to = p;
    this.toBox.setValue(p.label);
    if (fly && !this.from) this.map?.setView(p.location, 15);
    this.refresh();
  }

  private swap(): void {
    [this.from, this.to] = [this.to, this.from];
    this.fromBox.setValue(this.from?.label ?? '');
    this.toBox.setValue(this.to?.label ?? '');
    this.refresh();
  }

  private useMyLocation(): void {
    if (!navigator.geolocation) {
      toast('Location is not available in this browser.', 'warn');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => void this.presetStart({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => toast('Could not get your location. You can search or click the map instead.', 'warn'),
      { enableHighAccuracy: false, timeout: 10_000 },
    );
  }

  private refresh(): void {
    this.map?.setMarkers(this.from?.location ?? null, this.to?.location ?? null);
    this.route = null;
    this.startBtn.disabled = true;
    this.map?.setRoute(null);
    if (!this.from || !this.to) {
      this.summary.replaceChildren();
      this.hint.hidden = false;
      return;
    }
    this.hint.hidden = true;
    const crow = haversine(this.from.location, this.to.location);
    if (crow > MAX_ROUTE_M) {
      this.summary.replaceChildren(
        el(
          'p',
          { class: 'warn' },
          'That is a long way. Practice routes are limited to about 40 km (25 mi). Pick a closer destination.',
        ),
      );
      return;
    }
    void this.computeRoute();
  }

  private async computeRoute(): Promise<void> {
    if (!this.from || !this.to) return;
    const seq = ++this.seq;
    this.summary.replaceChildren(
      el('div', { class: 'loading' }, el('span', { class: 'spinner' }), 'Finding a route…'),
    );
    try {
      const route = await this.providers.routing.route(this.from.location, this.to.location);
      if (seq !== this.seq) return;
      if (route.distanceMeters > MAX_ROUTE_M * 1.5)
        throw new Error('That route is too long for a practice drive.');
      this.route = route;
      this.map?.setRoute(route.points);
      const turns = route.steps.filter(
        (s) => s.maneuver !== 'depart' && s.maneuver !== 'arrive',
      ).length;
      const hasLimits = route.speedLimits.length > 0;
      this.summary.replaceChildren(
        el(
          'div',
          { class: 'stats' },
          stat(fmtDistance(route.distanceMeters, this.settings.units), 'distance'),
          stat(fmtDuration(route.durationSeconds), 'typical time'),
          stat(String(turns), turns === 1 ? 'manoeuvre' : 'manoeuvres'),
        ),
        el(
          'p',
          { class: 'fineprint' },
          hasLimits
            ? 'Posted speed limits available on this route.'
            : 'Speed limits unavailable here; speeding checks are off.',
        ),
        el('p', { class: 'fineprint' }, route.attribution),
      );
      this.startBtn.disabled = false;
      if (this.providers.imagery) void this.checkCoverage(route, seq);
    } catch (err) {
      if (seq !== this.seq) return;
      this.summary.replaceChildren(
        el('p', { class: 'warn' }, `Couldn't find a route: ${(err as Error).message}`),
      );
    }
  }

  /** Tells the driver up front how much of the route has real 360° imagery. */
  private async checkCoverage(route: RouteData, seq: number): Promise<void> {
    const line = el(
      'p',
      { class: 'coverage' },
      el('span', { class: 'spinner' }),
      `Checking ${this.providers.imagery!.name} coverage…`,
    );
    this.summary.prepend(line);
    try {
      const source = this.providers.imagery!;
      const f = await source.coverage(route.points);
      if (seq !== this.seq) return;
      const pct = Math.round(f * 100);
      line.replaceChildren(
        el('span', { class: `coverage-dot ${pct >= 80 ? 'good' : pct >= 40 ? 'mid' : 'bad'}` }),
        pct >= 80
          ? `${source.name}: ${pct}% of this route has real 360° imagery`
          : pct > 0
            ? `${source.name}: about ${pct}% coverage. Gaps use a simulated road.`
            : `No ${source.name} 360° imagery here. You will drive a simulated road.`,
      );
    } catch {
      line.replaceChildren(`${this.providers.imagery!.name} coverage could not be checked.`);
    }
  }

  private start(): void {
    if (this.route && this.from && this.to) this.onStart?.(this.route, this.from, this.to);
  }

  /** Programmatic route setup, used by share links. */
  setEndpoints(from: Endpoint, to: Endpoint): void {
    this.setFrom(from, false);
    this.setTo(to, false);
  }

  get endpoints(): { from: Endpoint | null; to: Endpoint | null } {
    return { from: this.from, to: this.to };
  }

  destroy(): void {
    this.map?.destroy();
    this.root.remove();
  }
}

function stat(value: string, label: string): HTMLElement {
  return el('div', { class: 'stat' }, el('strong', {}, value), el('span', {}, label));
}
