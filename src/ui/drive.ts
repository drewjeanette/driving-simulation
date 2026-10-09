import { DrivePath } from '../geo/path';
import { RouteData, maneuverGlyph } from '../geo/route';
import { clamp, toDeg, wrapPi } from '../geo/geo';
import { drivesOnLeft } from '../geo/traffic';
import { AppProviders } from '../config';
import { CarAudio } from '../audio/audio';
import { InputManager } from '../input/input';
import { InputFrame } from '../input/types';
import { Coach, CoachEvent } from '../sim/coach';
import { Gear, ShiftResult } from '../sim/transmission';
import { DEFAULT_PARAMS, MPS_TO_KPH, MPS_TO_MPH, Vehicle } from '../sim/vehicle';
import { DriveRenderer } from '../render/renderer';
import { StreetViewLayer, loadWindow } from '../render/streetview';
import { CityLayer } from '../render/city';
import { signalState } from '../sim/traffic';
import { PlannerMap } from '../providers/types';
import { Hud, HudData } from './hud';
import { Settings, saveSettings } from './settings';
import { el, toast } from './dom';

export interface DriveResult {
  score: number;
  events: CoachEvent[];
  distance: number;
  seconds: number;
  maxSpeed: number;
  completed: boolean;
}

type Signal = 'left' | 'right' | 'hazard' | null;

const DEVICE_LABEL = {
  keyboard: 'Keyboard',
  gamepad: 'Controller',
  wheel: 'Racing wheel',
} as const;

/**
 * One drive from A to B: wires input, the vehicle model, the examiner,
 * rendering, sound and the HUD together and runs the frame loop.
 */
export class DriveSession {
  readonly root: HTMLElement;
  private readonly path: DrivePath;
  private readonly vehicle: Vehicle;
  private coach: Coach;
  private readonly renderer: DriveRenderer;
  private readonly hud: Hud;
  private readonly rightHand: boolean;
  private minimap: PlannerMap | null = null;
  private time = 0;
  private paused = false;
  private finished = false;
  private signal: Signal = null;
  private signalHeading = 0;
  private blinkTimer = 0;
  private blinkOn = false;
  private hudTimer = 0;
  private mapTimer = 0;
  private lookYaw = 0;
  private lookPitch = 0;
  private dragging = false;
  private started = false;
  private disposed = false;
  onFinish?: (r: DriveResult) => void;
  onPause?: () => void;
  /** A controller's pause button pressed while the pause menu is open. */
  onResumeRequest?: () => void;
  onSettings?: () => void;

  constructor(
    route: RouteData,
    private readonly providers: AppProviders,
    private readonly settings: Settings,
    private readonly input: InputManager,
    private readonly audio: CarAudio,
    vrAvailable: boolean,
  ) {
    this.path = new DrivePath(route);
    this.rightHand =
      settings.trafficSide === 'auto'
        ? !drivesOnLeft(route.points[0])
        : settings.trafficSide === 'right';
    this.vehicle = new Vehicle(this.path, {
      ...DEFAULT_PARAMS,
      laneCenter: this.rightHand ? DEFAULT_PARAMS.laneCenter : -DEFAULT_PARAMS.laneCenter,
    });
    this.vehicle.assist = settings.assist;
    this.coach = this.newCoach();

    this.root = el('section', { class: 'screen drive' });
    let streetView: StreetViewLayer | null = null;
    if (providers.imagery) {
      streetView = new StreetViewLayer(providers.imagery, this.path);
      streetView.quality = settings.quality;
      streetView.mode = settings.imageryMode;
      streetView.onError = (m) => toast(m, 'warn', 8000);
    }
    const city = new CityLayer(this.path);
    city.onError = (m) => toast(m, 'warn', 8000);
    this.renderer = new DriveRenderer(this.root, this.path, this.rightHand, streetView, city);
    this.renderer.setWorldView(settings.worldView === 'google3d' ? 'city' : settings.worldView);
    if (providers.googleKey) {
      // Loaded on demand so visitors in free mode never download the 3D tiles library.
      const key = providers.googleKey;
      void import('../render/googletiles').then(({ GoogleTilesLayer }) => {
        if (this.disposed) return;
        const tiles = new GoogleTilesLayer(
          key,
          route.points[0],
          this.renderer.camera,
          this.renderer.renderer,
        );
        tiles.onError = (m) => {
          toast(m, 'warn', 8000);
          this.renderer.setWorldView('city');
        };
        this.renderer.attachGoogleTiles(tiles);
        // Google 3D is the most realistic view, so it's the default when available.
        if (settings.worldView !== 'photos') this.renderer.setWorldView('google3d');
      });
    }
    this.renderer.onCityReady = () => {
      if (this.renderer.worldView === 'city') toast('3D city loaded from OpenStreetMap');
    };
    this.renderer.onXRChange = (on) => {
      this.hud.vrBtn.classList.toggle('active', on);
      if (on) toast('VR on. Look around with your head. Press Z or right-stick click to recenter.');
    };

    this.hud = new Hud(
      {
        onGear: (g) => this.shift(() => this.vehicle.transmission.select(g, this.shiftCtx())),
        onSignal: (s) => this.toggleSignal(s),
        onPause: () => this.pause(),
        onCamera: () => this.cycleCamera(),
        onMute: () => this.toggleMute(),
        onVR: () => void this.toggleVR(),
        onSettings: () => this.onSettings?.(),
      },
      vrAvailable,
    );
    this.hud.setMuted(this.audio.isMuted);
    this.root.append(this.hud.root);
    this.input.touch = this.hud.touch;
    this.bindMouseLook();
  }

  private newCoach(): Coach {
    const c = new Coach(this.path);
    c.onEvent((e) => {
      this.hud.showEvent(e);
      this.audio.chime(e.severity);
    });
    return c;
  }

  async mount(): Promise<void> {
    this.audio.start();
    this.hud.setBanner('Hold the brake (S / ↓ / LT) and shift into Drive (F or 4) to begin.');
    this.renderer.start((dt) => this.frame(dt));
    try {
      this.minimap = await this.providers.createMap(this.hud.minimapHost, {
        interactive: false,
        minimal: true,
      });
      this.minimap.setRoute(this.path.points(10).map((p) => this.path.toLatLng(p)));
    } catch {
      this.hud.minimapHost.hidden = true;
    }
  }

  private shiftCtx() {
    return {
      speed: this.vehicle.state.speed,
      brake: Math.max(this.lastInput?.brake ?? 0, this.input.touch?.brake ?? 0),
    };
  }

  private lastInput: InputFrame | null = null;

  private shift(fn: () => ShiftResult): void {
    const before = this.vehicle.gear;
    const r = fn();
    if (!r.ok) {
      this.audio.deny();
      this.hud.showEvent({ message: `${r.reason}. ${r.lesson}`, severity: 'tip' });
      this.coach.report('shiftBlocked', r.reason, this.time);
    } else if (r.gear !== before) {
      this.audio.tick(true);
      if (!this.started && r.gear === 'D') {
        this.started = true;
        this.hud.setBanner(null);
        this.hud.showEvent({
          message: 'Release the brake to creep forward, then use the gas gently.',
          severity: 'tip',
        });
      }
    }
  }

  private toggleSignal(side: 'left' | 'right' | 'hazard'): void {
    this.signal = this.signal === side ? null : side;
    this.signalHeading = this.vehicle.pose().heading;
    this.blinkTimer = 0;
    this.blinkOn = !!this.signal;
    if (this.signal) this.audio.tick(true);
  }

  private cycleCamera(): void {
    this.renderer.setView(this.renderer.view === 'cockpit' ? 'clean' : 'cockpit');
  }

  /**
   * V cycles through the available views: Google 3D (with a key), the
   * OpenStreetMap 3D city, then 360° photos in classic and smooth modes.
   */
  private toggleImageryMode(): void {
    type View = { world: Settings['worldView']; mode?: Settings['imageryMode']; label: string };
    const views: View[] = this.renderer.availableViews.flatMap((w): View[] =>
      w === 'photos'
        ? [
            {
              world: 'photos',
              mode: 'classic',
              label: 'Photo view (classic): one photo at a time',
            },
            {
              world: 'photos',
              mode: 'smooth',
              label: 'Photo view (smooth): neighbouring photos blended',
            },
          ]
        : [
            {
              world: w,
              label: w === 'google3d' ? 'Google 3D view' : '3D city view (OpenStreetMap)',
            },
          ],
    );
    if (views.length < 2) {
      toast('Only the 3D city is available here.');
      return;
    }
    const s = this.settings;
    const i = views.findIndex(
      (v) => v.world === s.worldView && (v.world !== 'photos' || v.mode === s.imageryMode),
    );
    const next = views[(i + 1) % views.length];
    s.worldView = next.world;
    if (next.mode) s.imageryMode = next.mode;
    if (this.renderer.streetView) this.renderer.streetView.mode = s.imageryMode;
    this.renderer.setWorldView(s.worldView);
    if (s.worldView === 'photos') this.renderer.setView('clean');
    saveSettings(s);
    toast(next.label);
  }

  private toggleMute(): void {
    this.audio.setMuted(!this.audio.isMuted);
    this.settings.muted = this.audio.isMuted;
    this.hud.setMuted(this.audio.isMuted);
  }

  private async toggleVR(): Promise<void> {
    try {
      if (this.renderer.inXR) await this.renderer.exitVR();
      else await this.renderer.enterVR();
    } catch (err) {
      toast(`Couldn't start VR: ${(err as Error).message}`, 'error');
    }
  }

  private handleActions(f: InputFrame): void {
    for (const a of f.actions) {
      switch (a) {
        case 'shiftUp':
          this.shift(() => this.vehicle.transmission.up(this.shiftCtx()));
          break;
        case 'shiftDown':
          this.shift(() => this.vehicle.transmission.down(this.shiftCtx()));
          break;
        case 'gearP':
        case 'gearR':
        case 'gearN':
        case 'gearD':
          this.shift(() => this.vehicle.transmission.select(a.slice(4) as Gear, this.shiftCtx()));
          break;
        case 'signalLeft':
          this.toggleSignal('left');
          break;
        case 'signalRight':
          this.toggleSignal('right');
          break;
        case 'hazards':
          this.toggleSignal('hazard');
          break;
        case 'camera':
          this.cycleCamera();
          break;
        case 'imageryMode':
          this.toggleImageryMode();
          break;
        case 'pause':
          this.pause();
          break;
        case 'recenter':
          this.lookYaw = this.lookPitch = 0;
          this.renderer.recenterVR();
          break;
        case 'horn':
          break;
      }
    }
  }

  private frame(dt: number): void {
    const f = this.input.poll(dt);
    this.lastInput = f;
    if (this.paused) {
      if (f.actions.includes('pause')) this.onResumeRequest?.();
      this.renderer.updateStreetView(this.vehicle.state.s, 0);
      return;
    }
    this.handleActions(f);
    if (this.paused || this.finished) return;
    this.time += dt;

    this.vehicle.update(f, dt);
    const st = this.vehicle.state;
    const pose = this.vehicle.pose();

    this.updateSignal(dt, pose.heading, f.steer);
    this.coach.update(
      {
        time: this.time,
        state: st,
        gear: this.vehicle.gear,
        signal: this.signal === 'hazard' ? null : this.signal,
        laneCenter: this.vehicle.params.laneCenter,
        controls: this.renderer.city?.controls,
      },
      dt,
    );

    // Right-stick look returns to centre; mouse look stays where you leave it.
    const stickYaw = -f.lookX * 1.2;
    const stickPitch = -f.lookY * 0.5;
    this.renderer.setLook(this.lookYaw + stickYaw, clamp(this.lookPitch + stickPitch, -0.6, 0.5));
    this.renderer.update(
      { ...pose, speed: st.speed, accel: st.accel, yawRate: st.yawRate, steerAngle: st.steerAngle },
      dt,
    );
    this.renderer.updateStreetView(st.s, dt, st.speed);
    this.renderer.updateCity(st.s, this.time, loadWindow(st.speed).ahead + 250);
    this.audio.update(st.rpm, f.throttle, st.speed, f.horn);

    this.hudTimer += dt;
    if (this.hudTimer > 1 / 30) {
      this.hudTimer = 0;
      this.updateHud(f);
    }
    this.mapTimer += dt;
    if (this.mapTimer > 0.25 && this.minimap) {
      this.mapTimer = 0;
      this.minimap.setCar(this.path.toLatLng(pose), toDeg(pose.heading));
    }

    this.checkArrival();
  }

  private updateSignal(dt: number, heading: number, steer: number): void {
    if (!this.signal) return;
    this.blinkTimer += dt;
    if (this.blinkTimer > 0.38) {
      this.blinkTimer = 0;
      this.blinkOn = !this.blinkOn;
      this.audio.tick(this.blinkOn);
    }
    // Self-cancel like a real stalk: after the car has turned and the wheel unwinds.
    if (
      this.signal !== 'hazard' &&
      Math.abs(wrapPi(heading - this.signalHeading)) > 1.0 &&
      Math.abs(steer) < 0.15
    ) {
      this.signal = null;
      this.blinkOn = false;
    }
  }

  private updateHud(f: InputFrame): void {
    const st = this.vehicle.state;
    const k = this.settings.units === 'mph' ? MPS_TO_MPH : MPS_TO_KPH;
    const limit = this.path.speedLimitAt(st.s);
    const next = this.path.nextStep(st.s);
    const toNext = next ? next.s - st.s : this.path.length - st.s;
    const nav = {
      glyph: maneuverGlyph(next?.maneuver ?? 'arrive'),
      distance: this.formatDistance(Math.max(0, toNext)),
      instruction: next?.instruction || 'Continue to your destination',
    };
    const speedLimit = limit !== null ? limit * k : null;
    this.hud.update({
      speed: st.speed * k,
      units: this.settings.units,
      limit: speedLimit,
      gear: this.vehicle.gear,
      rpm: st.rpm,
      throttle: f.throttle,
      brake: f.brake,
      steer: f.steer,
      signal: this.signal,
      blinkOn: this.blinkOn,
      glyph: nav.glyph,
      navDistance: nav.distance,
      navInstruction: nav.instruction,
      control: this.controlAhead(),
      score: this.coach.score,
      progress: st.s / this.path.length,
      attribution: this.imageryCredit(),
      device: DEVICE_LABEL[f.device],
    });
    this.renderer.cockpit.drawCluster({
      speed: st.speed * k,
      units: this.settings.units,
      rpm: st.rpm,
      gear: this.vehicle.gear,
      autoGear: st.autoGear,
      limit: speedLimit,
      signal: this.signal,
      blinkOn: this.blinkOn,
      throttle: f.throttle,
      brake: f.brake,
    });
    if (this.renderer.inXR) {
      const last = this.coach.events[this.coach.events.length - 1];
      this.renderer.cockpit.drawNav({
        ...nav,
        message: last && this.time - last.at < 5 ? last.message : '',
      });
    }
  }

  private imageryCredit(): string {
    if (this.renderer.worldView === 'google3d') return this.renderer.googleTiles?.attribution ?? '';
    if (this.renderer.worldView === 'city') return '3D city © OpenStreetMap contributors';
    const sv = this.renderer.streetView;
    if (!sv?.coverage) return '';
    const buffered = `${this.formatDistance(sv.bufferedAhead)} buffered`;
    return [sv.source.credit, sv.attribution, buffered].filter(Boolean).join(' · ');
  }

  /** The next stop sign or signal within 120 m, for the HUD. */
  private controlAhead(): HudData['control'] {
    const c = this.renderer.city?.nextControl(this.vehicle.state.s);
    if (!c) return null;
    const d = c.s - this.vehicle.state.s;
    if (d > 120 || d < -1) return null;
    return {
      kind: c.kind === 'stop' ? 'stop' : signalState(c.id, this.time),
      distance: this.formatDistance(Math.max(0, d)),
    };
  }

  private checkArrival(): void {
    const st = this.vehicle.state;
    const remaining = this.path.length - st.s;
    if (remaining < 25 && !this.finished) {
      if (Math.abs(st.speed) < 0.3 && this.vehicle.gear === 'P') {
        this.finish(true);
      } else if (remaining < 15) {
        this.hud.setBanner('You have arrived. Stop, then shift into Park (R or 1) to finish.');
      }
    }
  }

  private formatDistance(m: number): string {
    if (this.settings.units === 'mph') {
      const ft = m * 3.28084;
      return ft < 1000
        ? `${Math.max(0, Math.round(ft / 50) * 50)} ft`
        : `${(m / 1609.34).toFixed(1)} mi`;
    }
    return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
  }

  pause(): void {
    if (this.finished || this.paused) return;
    this.paused = true;
    this.audio.suspend();
    this.input.keyboard.setEnabled(false);
    this.onPause?.();
  }

  resume(): void {
    this.paused = false;
    this.audio.resume();
    this.input.keyboard.setEnabled(true);
  }

  restart(): void {
    this.vehicle.reset();
    this.vehicle.assist = this.settings.assist;
    this.coach = this.newCoach();
    this.time = 0;
    this.signal = null;
    this.finished = false;
    this.started = false;
    this.hud.setBanner('Hold the brake and shift into Drive to begin.');
    this.resume();
  }

  /** Applies settings changed mid-drive. */
  applySettings(): void {
    this.vehicle.assist = this.settings.assist;
    if (this.renderer.streetView) {
      this.renderer.streetView.quality = this.settings.quality;
      this.renderer.streetView.mode = this.settings.imageryMode;
    }
    this.renderer.setWorldView(this.settings.worldView);
  }

  finish(completed: boolean): void {
    if (this.finished) return;
    this.finished = true;
    this.audio.suspend();
    void this.renderer.exitVR().catch(() => undefined);
    this.onFinish?.({
      score: this.coach.score,
      events: [...this.coach.events],
      distance: this.coach.distanceDriven,
      seconds: this.time,
      maxSpeed: this.coach.maxSpeed,
      completed,
    });
  }

  private bindMouseLook(): void {
    const canvas = this.renderer.renderer.domElement;
    let lastX = 0;
    let lastY = 0;
    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') return;
      this.dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      this.lookYaw = clamp(this.lookYaw - (e.clientX - lastX) * 0.004, -2.6, 2.6);
      this.lookPitch = clamp(this.lookPitch - (e.clientY - lastY) * 0.003, -0.6, 0.5);
      lastX = e.clientX;
      lastY = e.clientY;
    });
    canvas.addEventListener('pointerup', () => (this.dragging = false));
    canvas.addEventListener('dblclick', () => (this.lookYaw = this.lookPitch = 0));
  }

  destroy(): void {
    this.disposed = true;
    this.input.touch = null;
    this.input.keyboard.setEnabled(true);
    this.minimap?.destroy();
    this.renderer.dispose();
    this.audio.suspend();
    this.root.remove();
  }
}
