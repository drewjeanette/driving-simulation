import { SteeringAssist } from '../sim/vehicle';
import { StreetViewQuality } from '../render/streetview';

export interface Settings {
  units: 'mph' | 'km/h';
  assist: SteeringAssist;
  trafficSide: 'auto' | 'right' | 'left';
  quality: StreetViewQuality;
  muted: boolean;
  /** Use OpenStreetMap data even when a Google key is configured. */
  preferOpen: boolean;
}

const KEY = 'drive-sim:settings:v1';

function defaults(): Settings {
  const lang = typeof navigator !== 'undefined' ? navigator.language : 'en-US';
  const imperial = /^en-(US|GB|LR|MM)$/i.test(lang);
  return {
    units: imperial ? 'mph' : 'km/h',
    assist: 'curves',
    trafficSide: 'auto',
    quality: 'high',
    muted: false,
    preferOpen: false,
  };
}

const ALLOWED: { [K in keyof Settings]: readonly Settings[K][] } = {
  units: ['mph', 'km/h'],
  assist: ['off', 'curves', 'lane'],
  trafficSide: ['auto', 'right', 'left'],
  quality: ['low', 'high', 'ultra'],
  muted: [true, false],
  preferOpen: [true, false],
};

/** Loads settings, keeping only known keys with allowed values. */
export function loadSettings(): Settings {
  const out = defaults();
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    if (raw && typeof raw === 'object') {
      for (const k of Object.keys(ALLOWED) as (keyof Settings)[]) {
        const v = (raw as Record<string, unknown>)[k];
        if ((ALLOWED[k] as readonly unknown[]).includes(v))
          (out as unknown as Record<string, unknown>)[k] = v;
      }
    }
  } catch {
    /* corrupt or unavailable storage: use defaults */
  }
  return out;
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}
