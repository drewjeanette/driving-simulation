import { clamp } from '../geo/geo';
import { Action, InputFrame } from './types';

/** How one analog control is read from a raw gamepad axis or button. */
export interface AxisBinding {
  kind: 'axis' | 'button';
  index: number;
  /** Raw value at rest. */
  rest: number;
  /** Raw value at full travel (for steering: full right). */
  full: number;
}

export interface DeviceProfile {
  /** The Gamepad.id this profile belongs to. */
  id: string;
  type: 'gamepad' | 'wheel';
  steer: AxisBinding;
  throttle: AxisBinding;
  brake: AxisBinding;
  /** Wheel rotation lock-to-lock in degrees; only used for display. */
  rotationDeg: number;
  deadzone: number;
  /** Exponent applied to stick steering for finer control near centre. */
  steerCurve: number;
  buttons: Partial<Record<Action, number>>;
}

const WHEEL_PATTERN =
  /wheel|racing|G2[0-9]{2}|G9[0-9]{2}|G PRO|T150|T248|T300|TMX|T-?GT|Fanatec|Thrustmaster|Driving Force|DFGT|Moza|Simagic|Logitech.*(G29|G920|G923)/i;

export function looksLikeWheel(pad: Gamepad): boolean {
  return WHEEL_PATTERN.test(pad.id) || (pad.mapping !== 'standard' && pad.axes.length >= 3);
}

/** W3C "standard" mapping: Xbox, PlayStation, Switch Pro and most modern pads. */
export function standardProfile(id: string): DeviceProfile {
  return {
    id,
    type: 'gamepad',
    steer: { kind: 'axis', index: 0, rest: 0, full: 1 },
    throttle: { kind: 'button', index: 7, rest: 0, full: 1 },
    brake: { kind: 'button', index: 6, rest: 0, full: 1 },
    rotationDeg: 900,
    deadzone: 0.08,
    steerCurve: 1.6,
    buttons: {
      shiftUp: 12, // d-pad up
      shiftDown: 13, // d-pad down
      signalLeft: 4, // LB / L1
      signalRight: 5, // RB / R1
      hazards: 1, // B / Circle
      horn: 10, // left stick click
      camera: 3, // Y / Triangle
      pause: 9, // Menu / Options
      recenter: 11, // right stick click
      imageryMode: 2, // X / Square
    },
  };
}

/** A best guess for an uncalibrated wheel; the calibration wizard replaces it. */
export function defaultWheelProfile(id: string): DeviceProfile {
  return {
    id,
    type: 'wheel',
    steer: { kind: 'axis', index: 0, rest: 0, full: 1 },
    throttle: { kind: 'axis', index: 2, rest: 1, full: -1 },
    brake: { kind: 'axis', index: 3, rest: 1, full: -1 },
    rotationDeg: 900,
    deadzone: 0.01,
    steerCurve: 1,
    buttons: {
      shiftUp: 4,
      shiftDown: 5,
      signalLeft: 6,
      signalRight: 7,
      pause: 9,
      camera: 3,
      horn: 0,
    },
  };
}

export function readRaw(pad: Gamepad, b: AxisBinding): number {
  if (b.kind === 'axis') return pad.axes[b.index] ?? b.rest;
  const btn = pad.buttons[b.index];
  return btn ? btn.value : b.rest;
}

/** Normalises a pedal-style control to 0..1 from its calibrated rest/full values. */
export function readPedal(pad: Gamepad, b: AxisBinding, deadzone: number): number {
  const span = b.full - b.rest;
  if (span === 0) return 0;
  const v = clamp((readRaw(pad, b) - b.rest) / span, 0, 1);
  return v < deadzone ? 0 : (v - deadzone) / (1 - deadzone);
}

/** Normalises steering to -1..1 around its rest (centre) value. */
export function readSteer(pad: Gamepad, profile: DeviceProfile): number {
  const b = profile.steer;
  const span = b.full - b.rest;
  if (span === 0) return 0;
  let v = clamp((readRaw(pad, b) - b.rest) / span, -1, 1);
  const dz = profile.deadzone;
  v = Math.abs(v) < dz ? 0 : (Math.sign(v) * (Math.abs(v) - dz)) / (1 - dz);
  return Math.sign(v) * Math.abs(v) ** profile.steerCurve;
}

const STORAGE_KEY = 'drive-sim:profiles:v1';

export function loadProfiles(): Record<string, DeviceProfile> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, DeviceProfile> = {};
    for (const [id, p] of Object.entries(parsed as Record<string, unknown>)) {
      if (isProfile(p)) out[id] = p;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveProfiles(profiles: Record<string, DeviceProfile>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles));
  } catch {
    /* storage unavailable: profiles last for this session only */
  }
}

function isBinding(b: unknown): b is AxisBinding {
  const x = b as AxisBinding;
  return (
    !!x &&
    (x.kind === 'axis' || x.kind === 'button') &&
    Number.isInteger(x.index) &&
    Number.isFinite(x.rest) &&
    Number.isFinite(x.full)
  );
}

function isProfile(p: unknown): p is DeviceProfile {
  const x = p as DeviceProfile;
  return (
    !!x &&
    typeof x.id === 'string' &&
    (x.type === 'gamepad' || x.type === 'wheel') &&
    isBinding(x.steer) &&
    isBinding(x.throttle) &&
    isBinding(x.brake) &&
    Number.isFinite(x.deadzone) &&
    Number.isFinite(x.steerCurve) &&
    typeof x.buttons === 'object'
  );
}

/**
 * Polls every connected controller each frame. Standard gamepads work out of
 * the box; wheels and pedal sets use a per-device profile created by the
 * calibration wizard and stored in localStorage.
 */
export class GamepadInput {
  profiles = loadProfiles();
  private prevButtons = new Map<number, boolean[]>();
  private activity = new Map<number, number>();
  onConnect?: (pad: Gamepad, needsCalibration: boolean) => void;

  constructor() {
    window.addEventListener('gamepadconnected', (e) => {
      const pad = e.gamepad;
      const wheel = looksLikeWheel(pad);
      this.onConnect?.(pad, wheel && !this.profiles[pad.id]);
    });
  }

  profileFor(pad: Gamepad): DeviceProfile {
    return (
      this.profiles[pad.id] ??
      (looksLikeWheel(pad) ? defaultWheelProfile(pad.id) : standardProfile(pad.id))
    );
  }

  setProfile(profile: DeviceProfile): void {
    this.profiles[profile.id] = profile;
    saveProfiles(this.profiles);
  }

  removeProfile(id: string): void {
    delete this.profiles[id];
    saveProfiles(this.profiles);
  }

  connected(): Gamepad[] {
    if (!navigator.getGamepads) return [];
    return navigator.getGamepads().filter((p): p is Gamepad => !!p && p.connected);
  }

  poll(frame: InputFrame): void {
    for (const pad of this.connected()) {
      const profile = this.profileFor(pad);
      const throttle = readPedal(pad, profile.throttle, 0.02);
      const brake = readPedal(pad, profile.brake, 0.02);
      const steer = readSteer(pad, profile);

      const moved = throttle > 0.02 || brake > 0.02 || Math.abs(steer) > 0.05;
      if (moved) this.activity.set(pad.index, performance.now());
      // Only the most recently used controller drives, so an idle second pad
      // (or a wheel's resting pedals) can't fight the active one.
      if (moved || this.isMostRecent(pad.index)) {
        frame.throttle = Math.max(frame.throttle, throttle);
        frame.brake = Math.max(frame.brake, brake);
        if (Math.abs(steer) > Math.abs(frame.steer)) {
          frame.steer = steer;
          frame.steerIsAbsolute = profile.type === 'wheel';
        }
        if (moved) frame.device = profile.type;
      }

      if (profile.type === 'gamepad' && pad.axes.length >= 4) {
        const dz = (v: number) => (Math.abs(v) < 0.15 ? 0 : v);
        frame.lookX = dz(pad.axes[2]);
        frame.lookY = dz(pad.axes[3]);
      }

      const prev = this.prevButtons.get(pad.index) ?? [];
      const now = pad.buttons.map((b) => b.pressed);
      for (const [action, idx] of Object.entries(profile.buttons) as [Action, number][]) {
        if (now[idx] && !prev[idx]) {
          frame.actions.push(action);
          this.activity.set(pad.index, performance.now());
        }
        if (action === 'horn' && now[idx]) frame.horn = true;
      }
      this.prevButtons.set(pad.index, now);
    }
  }

  private isMostRecent(index: number): boolean {
    let best = -1;
    let bestT = -Infinity;
    for (const [i, t] of this.activity) {
      if (t > bestT) {
        bestT = t;
        best = i;
      }
    }
    return best === index;
  }
}
