import './styles/main.css';
import { AppProviders, createProviders } from './config';
import { CarAudio } from './audio/audio';
import { InputManager } from './input/input';
import { LatLng } from './geo/geo';
import { RouteData } from './geo/route';
import { DriveRenderer } from './render/renderer';
import { DriveSession } from './ui/drive';
import { LandingScreen } from './ui/landing';
import { Modal } from './ui/modal';
import { pauseMenu, reportCard, settingsPanel } from './ui/panels';
import { Endpoint, PlannerScreen } from './ui/planner';
import { loadSettings, saveSettings } from './ui/settings';
import { el, toast } from './ui/dom';

/** Parses "lat,lng" from a share link, rejecting anything that isn't a coordinate. */
function parseCoord(v: string | null): LatLng | null {
  if (!v) return null;
  const m = /^(-?\d{1,2}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)$/.exec(v.trim());
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

class App {
  private readonly host: HTMLElement;
  private readonly settings = loadSettings();
  private readonly input = new InputManager();
  private readonly audio = new CarAudio();
  private providers!: AppProviders;
  private landing: LandingScreen | null = null;
  private planner: PlannerScreen | null = null;
  private drive: DriveSession | null = null;
  private lastRoute: { route: RouteData; from: Endpoint; to: Endpoint } | null = null;
  private vrAvailable = false;

  constructor(host: HTMLElement) {
    this.host = host;
  }

  async start(): Promise<void> {
    this.audio.setMuted(this.settings.muted);
    window.__gmapsAuthFailed = () => {
      toast(
        'Google rejected the API key, so the app switched to OpenStreetMap mode.',
        'warn',
        8000,
      );
      this.settings.preferOpen = true;
      saveSettings(this.settings);
      setTimeout(() => location.reload(), 1500);
    };
    [this.providers, this.vrAvailable] = await Promise.all([
      createProviders(this.settings.preferOpen),
      DriveRenderer.vrSupported(),
    ]);
    document.documentElement.dataset.mode = this.providers.mode;
    this.input.gamepads.onConnect = (pad, needsCalibration) => {
      toast(
        needsCalibration
          ? `Racing wheel connected. Open Settings → Controllers to calibrate it.`
          : `Controller connected: ${pad.id.replace(/\(.*?\)/g, '').trim() || 'gamepad'}`,
      );
    };
    document.getElementById('boot')?.remove();

    const params = new URLSearchParams(location.search);
    const from = parseCoord(params.get('from'));
    const to = parseCoord(params.get('to'));
    if (from && to) {
      await this.showPlanner(from);
      this.planner?.setEndpoints(
        { label: 'Shared start', location: from },
        { label: 'Shared destination', location: to },
      );
    } else {
      this.showLanding();
    }
  }

  private clearScreens(): void {
    this.landing?.destroy();
    this.landing = null;
    this.planner?.destroy();
    this.planner = null;
    this.drive?.destroy();
    this.drive = null;
  }

  private showLanding(): void {
    this.clearScreens();
    const landing = new LandingScreen(this.providers.search, this.providers.mode);
    landing.onChoose = (p, label) => void this.showPlanner(p, label);
    landing.onPlan = () => void this.showPlanner();
    this.host.append(landing.root);
    landing.mount();
    this.landing = landing;
  }

  private async showPlanner(start?: LatLng, label?: string): Promise<void> {
    this.clearScreens();
    const planner = new PlannerScreen(this.providers, this.settings);
    planner.onBack = () => this.showLanding();
    planner.onSettings = () => this.openSettings();
    planner.onStart = (route, from, to) => this.startDrive(route, from, to);
    this.host.append(planner.root);
    this.planner = planner;
    await planner.mount(start);
    if (start) await planner.presetStart(start, label);
  }

  private startDrive(route: RouteData, from: Endpoint, to: Endpoint): void {
    this.lastRoute = { route, from, to };
    this.clearScreens();
    history.replaceState(null, '', this.shareUrl(from.location, to.location));
    let session: DriveSession;
    try {
      session = new DriveSession(
        route,
        this.providers,
        this.settings,
        this.input,
        this.audio,
        this.vrAvailable,
      );
    } catch (err) {
      toast(`Couldn't start the drive: ${(err as Error).message}`, 'error');
      void this.showPlanner(from.location);
      return;
    }
    let pause: Modal | null = null;
    session.onPause = () => {
      pause = pauseMenu({
        resume: () => session.resume(),
        restart: () => session.restart(),
        settings: () => this.openSettings(() => session.applySettings()),
        end: () => session.finish(false),
        exit: () => this.backToPlanner(),
      });
    };
    session.onResumeRequest = () => pause?.close();
    session.onSettings = () => {
      session.pause();
      this.openSettings(() => session.applySettings());
    };
    session.onFinish = (r) => {
      reportCard(r, this.settings.units, {
        again: () =>
          this.lastRoute &&
          this.startDrive(this.lastRoute.route, this.lastRoute.from, this.lastRoute.to),
        plan: () => this.backToPlanner(),
      });
    };
    this.host.append(session.root);
    this.drive = session;
    void session.mount();
  }

  private backToPlanner(): void {
    const last = this.lastRoute;
    void this.showPlanner(last?.from.location).then(() => {
      if (last) this.planner?.setEndpoints(last.from, last.to);
    });
  }

  private shareUrl(a: LatLng, b: LatLng): string {
    const f = (p: LatLng) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
    return `${location.pathname}?from=${f(a)}&to=${f(b)}`;
  }

  private openSettings(after?: () => void): void {
    const m = settingsPanel(this.settings, this.input, (reload) => {
      saveSettings(this.settings);
      if (reload) location.reload();
    });
    m.onClose = () => {
      saveSettings(this.settings);
      after?.();
    };
  }
}

const host = document.getElementById('app');
if (host) {
  new App(host).start().catch((err: Error) => {
    console.error(err);
    host.replaceChildren(
      el('div', { class: 'fatal' }, el('h1', {}, 'Something went wrong'), el('p', {}, err.message)),
    );
  });
}
