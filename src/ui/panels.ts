import {
  getStoredKey,
  getStoredMapillaryToken,
  isPlausibleKey,
  setStoredKey,
  setStoredMapillaryToken,
} from '../config';
import { isPlausibleMapillaryToken } from '../providers/mapillary';
import { InputManager } from '../input/input';
import {
  ControlDetector,
  BUTTON_STEPS,
  buildProfile,
  newlyPressed,
  snapshot,
  PadSnapshot,
} from '../input/calibrate';
import { AxisBinding, looksLikeWheel } from '../input/gamepad';
import { ACTION_LABELS, Action } from '../input/types';
import { grade } from '../sim/coach';
import { MPS_TO_KPH, MPS_TO_MPH } from '../sim/vehicle';
import { DriveResult } from './drive';
import { Settings } from './settings';
import { Modal } from './modal';
import { el, icon, toast } from './dom';

// ---------------------------------------------------------------- Pause menu

export function pauseMenu(handlers: {
  resume(): void;
  restart(): void;
  settings(): void;
  end(): void;
  exit(): void;
}): Modal {
  const m = new Modal('Paused');
  const btn = (label: string, iconName: string, fn: () => void, cls = 'btn') =>
    el('button', { class: cls, onclick: () => fn() }, icon(iconName, 16), label);
  m.body.append(
    el(
      'div',
      { class: 'menu' },
      btn('Resume', 'play', () => m.close(), 'btn btn-primary'),
      btn('Restart drive', 'restart', () => {
        m.onClose = undefined;
        m.close();
        handlers.restart();
      }),
      btn('Settings & controls', 'settings', () => handlers.settings()),
      btn('Finish & see report', 'flag', () => {
        m.onClose = undefined;
        m.close();
        handlers.end();
      }),
      btn('Plan a new route', 'route', () => {
        m.onClose = undefined;
        m.close();
        handlers.exit();
      }),
    ),
    controlsCheatSheet(),
  );
  m.onClose = handlers.resume;
  return m;
}

function controlsCheatSheet(): HTMLElement {
  const rows: [string, string, string][] = [
    ['Gas / brake', 'W S  or  ↑ ↓  (Space = hard brake)', 'RT / LT'],
    ['Steer', 'A D  or  ← →  (hold Shift = gentle)', 'Left stick'],
    ['Shift lever up / down', 'R / F   (1 2 3 4 = P R N D)', 'D-pad ↑ / ↓'],
    ['Turn signals', 'Q / E   (X = hazards)', 'LB / RB'],
    ['Look around', 'Drag the mouse (double-click resets)', 'Right stick'],
    ['Horn · Camera · Pause', 'H · C · Esc', 'L3 · Y · Menu'],
  ];
  return el(
    'table',
    { class: 'keys' },
    el(
      'thead',
      {},
      el('tr', {}, el('th', {}, 'Control'), el('th', {}, 'Keyboard'), el('th', {}, 'Controller')),
    ),
    el(
      'tbody',
      {},
      ...rows.map(([a, b, c]) =>
        el(
          'tr',
          {},
          el('td', {}, a),
          el('td', {}, el('kbd', {}, b)),
          el('td', {}, el('kbd', {}, c)),
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------- Settings

export function settingsPanel(
  settings: Settings,
  input: InputManager,
  onChange: (reload: boolean) => void,
): Modal {
  const m = new Modal('Settings', { wide: true });
  const tabs = ['Driving', 'Controllers', 'Map data'] as const;
  const panes = new Map<string, HTMLElement>();
  const tabBar = el('div', { class: 'tabs', role: 'tablist' });
  const show = (t: string) => {
    for (const [name, pane] of panes) pane.hidden = name !== t;
    [...tabBar.children].forEach((b) =>
      b.setAttribute('aria-selected', String(b.textContent === t)),
    );
  };
  for (const t of tabs)
    tabBar.append(el('button', { role: 'tab', class: 'tab', onclick: () => show(t) }, t));

  panes.set(
    'Driving',
    drivingPane(settings, () => onChange(false)),
  );
  panes.set('Controllers', controllersPane(input));
  panes.set('Map data', dataPane(settings, onChange));
  m.body.append(tabBar, ...panes.values());
  show('Driving');
  return m;
}

function choice<K extends keyof Settings>(
  settings: Settings,
  key: K,
  label: string,
  options: [Settings[K], string][],
  hint: string,
  onChange: () => void,
): HTMLElement {
  const group = el('div', { class: 'segmented', role: 'radiogroup', 'aria-label': label });
  const render = () =>
    [...group.children].forEach((b, i) =>
      b.setAttribute('aria-checked', String(options[i][0] === settings[key])),
    );
  for (const [value, text] of options) {
    group.append(
      el(
        'button',
        {
          role: 'radio',
          onclick: () => {
            settings[key] = value;
            render();
            onChange();
          },
        },
        text,
      ),
    );
  }
  render();
  return el(
    'div',
    { class: 'field' },
    el('div', { class: 'field-label' }, label),
    group,
    el('p', { class: 'hint' }, hint),
  );
}

function drivingPane(s: Settings, changed: () => void): HTMLElement {
  return el(
    'div',
    { class: 'pane' },
    choice(
      s,
      'assist',
      'Steering assist',
      [
        ['off', 'Off'],
        ['curves', 'Curves'],
        ['lane', 'Lane keep'],
      ],
      'Curves: the car follows bends, you hold the lane. Off is the most realistic. Lane keep is best for a first drive.',
      changed,
    ),
    choice(
      s,
      'units',
      'Units',
      [
        ['mph', 'mph'],
        ['km/h', 'km/h'],
      ],
      'Speed and distance units.',
      changed,
    ),
    choice(
      s,
      'trafficSide',
      'Drive on the',
      [
        ['auto', 'Auto'],
        ['right', 'Right'],
        ['left', 'Left'],
      ],
      'Auto picks based on where the route is.',
      changed,
    ),
    choice(
      s,
      'quality',
      'Street View quality',
      [
        ['low', 'Fast'],
        ['high', 'Sharp (4K)'],
        ['ultra', 'Ultra (8K)'],
      ],
      'Higher settings load full-resolution 360° photos around the car. Ultra uses much more data and GPU memory.',
      changed,
    ),
  );
}

function controllersPane(input: InputManager): HTMLElement {
  const list = el('div', { class: 'devices' });
  const render = () => {
    list.replaceChildren();
    const pads = input.gamepads.connected();
    if (!pads.length) {
      list.append(
        el(
          'div',
          { class: 'empty' },
          icon('gamepad', 28),
          el(
            'p',
            {},
            'No controller detected. Plug in an Xbox, PlayStation or other controller, or a racing wheel, then press any button.',
          ),
        ),
      );
    }
    for (const pad of pads) {
      const profile = input.gamepads.profileFor(pad);
      const custom = !!input.gamepads.profiles[pad.id];
      list.append(
        el(
          'div',
          { class: 'device' },
          icon(profile.type === 'wheel' ? 'wheel' : 'gamepad', 22),
          el(
            'div',
            { class: 'device-info' },
            el('strong', {}, pad.id.replace(/\(.*?\)/g, '').trim() || 'Controller'),
            el(
              'span',
              {},
              profile.type === 'wheel'
                ? custom
                  ? 'Racing wheel · calibrated'
                  : 'Racing wheel · needs calibration'
                : pad.mapping === 'standard'
                  ? 'Standard gamepad · ready'
                  : 'Gamepad · non-standard layout, calibrate for best results',
            ),
          ),
          el(
            'button',
            { class: 'btn btn-sm', onclick: () => calibrate(input, pad.index, render) },
            'Calibrate',
          ),
          custom
            ? el(
                'button',
                {
                  class: 'btn btn-sm btn-ghost',
                  onclick: () => {
                    input.gamepads.removeProfile(pad.id);
                    render();
                  },
                },
                'Reset',
              )
            : null,
        ),
      );
    }
  };
  render();
  const onConn = () => render();
  window.addEventListener('gamepadconnected', onConn);
  window.addEventListener('gamepaddisconnected', onConn);
  return el(
    'div',
    { class: 'pane' },
    list,
    el(
      'p',
      { class: 'hint' },
      'Wheels and pedal sets (Logitech, Thrustmaster, Fanatec, Moza and others) report their axes differently. Calibration takes 30 seconds and is saved in this browser.',
    ),
    controlsCheatSheet(),
  );
}

/** A password-style field for a credential that is saved in this browser only. */
function credentialField(opts: {
  label: string;
  placeholder: string;
  value: string;
  valid: (v: string) => boolean;
  invalidMessage: string;
  save: (v: string) => void;
  hint: string;
  onSaved: () => void;
}): HTMLElement {
  const input = el('input', {
    class: 'text-input',
    type: 'password',
    placeholder: opts.placeholder,
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-label': opts.label,
    value: opts.value,
  });
  const save = el(
    'button',
    {
      class: 'btn btn-sm',
      onclick: () => {
        const v = input.value.trim();
        if (v && !opts.valid(v)) {
          toast(opts.invalidMessage, 'error');
          return;
        }
        opts.save(v);
        opts.onSaved();
      },
    },
    'Save & reload',
  );
  return el(
    'div',
    { class: 'field' },
    el('div', { class: 'field-label' }, opts.label),
    el('div', { class: 'row' }, input, save),
    el('p', { class: 'hint' }, opts.hint),
  );
}

function dataPane(s: Settings, onChange: (reload: boolean) => void): HTMLElement {
  return el(
    'div',
    { class: 'pane' },
    choice(
      s,
      'preferOpen',
      'Map provider',
      [
        [false, 'Google if configured'],
        [true, 'Free only (OpenStreetMap + Mapillary)'],
      ],
      'The free option needs no billing account: OpenStreetMap maps and routing with Mapillary 360° photos. Google adds wider Street View coverage but is a paid API.',
      () => onChange(true),
    ),
    credentialField({
      label: 'Mapillary client token (free)',
      placeholder: 'MLY|…',
      value: getStoredMapillaryToken(),
      valid: isPlausibleMapillaryToken,
      invalidMessage: 'That does not look like a Mapillary client token (MLY|…).',
      save: setStoredMapillaryToken,
      hint: 'Optional if the site already provides one. Get a free token at mapillary.com/dashboard/developers. Stored only in this browser.',
      onSaved: () => onChange(true),
    }),
    credentialField({
      label: 'Google Maps API key (optional, paid)',
      placeholder: 'AIza…',
      value: getStoredKey(),
      valid: isPlausibleKey,
      invalidMessage: 'That does not look like a Google Maps API key.',
      save: setStoredKey,
      hint: 'Stored only in this browser and sent only to Google. Restrict the key to your website in Google Cloud Console. Needs Maps JavaScript, Places (New), Routes, Geocoding and Map Tiles APIs.',
      onSaved: () => onChange(true),
    }),
  );
}

// ---------------------------------------------------------------- Calibration wizard

type Step =
  | { kind: 'center' }
  | { kind: 'steer' }
  | { kind: 'pedal'; which: 'throttle' | 'brake' }
  | { kind: 'button'; action: Action };

function calibrate(input: InputManager, padIndex: number, done: () => void): void {
  const pad0 = navigator.getGamepads()[padIndex];
  if (!pad0) return;
  const m = new Modal('Calibrate controller');
  const id = pad0.id;
  const wheel = looksLikeWheel(pad0);
  const steps: Step[] = [
    { kind: 'center' },
    { kind: 'steer' },
    { kind: 'pedal', which: 'throttle' },
    { kind: 'pedal', which: 'brake' },
    ...BUTTON_STEPS.map((action) => ({ kind: 'button' as const, action })),
  ];
  const prompts: Record<string, string> = {
    center: wheel
      ? 'Centre the wheel and take your feet off the pedals.'
      : 'Let go of all sticks and triggers.',
    steer: wheel
      ? 'Turn the wheel all the way to the RIGHT and hold it.'
      : 'Push the steering stick all the way RIGHT and hold it.',
    throttle: 'Press the GAS fully, then release it.',
    brake: 'Press the BRAKE fully, then release it.',
  };

  let i = 0;
  let center: PadSnapshot | null = null;
  let detector = new ControlDetector();
  let prev: PadSnapshot | null = null;
  let steer: AxisBinding | null = null;
  let throttle: AxisBinding | null = null;
  let brake: AxisBinding | null = null;
  const buttons: Partial<Record<Action, number>> = {};
  let raf = 0;

  const title = el('p', { class: 'calib-step' });
  const prompt = el('p', { class: 'calib-prompt' });
  const meter = el('div', { class: 'calib-meter' }, el('i', {}));
  const next = el('button', { class: 'btn btn-primary', onclick: () => advance() }, 'Next');
  const skip = el('button', { class: 'btn btn-ghost', onclick: () => advance(true) }, 'Skip');
  m.body.append(title, prompt, meter, el('div', { class: 'row end' }, skip, next));

  const exclude = () =>
    [steer, throttle, brake]
      .filter((b): b is AxisBinding => !!b)
      .map((b) => ({ kind: b.kind, index: b.index }));

  const render = () => {
    const s = steps[i];
    title.textContent = `Step ${i + 1} of ${steps.length}`;
    prompt.textContent =
      s.kind === 'button'
        ? `Press the button you want for: ${ACTION_LABELS[s.action]}`
        : prompts[s.kind === 'pedal' ? s.which : s.kind];
    skip.hidden = s.kind === 'center' || s.kind === 'steer';
    next.hidden = s.kind === 'button';
  };

  const advance = (skipped = false) => {
    const s = steps[i];
    const pad = navigator.getGamepads()[padIndex];
    if (!pad) return;
    if (s.kind === 'center') center = snapshot(pad);
    else if (s.kind === 'steer' && center) {
      steer = detector.detectSteer(center);
      if (!steer) {
        prompt.textContent = 'No movement detected. Turn further and hold, then press Next.';
        return;
      }
    } else if (s.kind === 'pedal' && !skipped) {
      const b = detector.detectPedal();
      if (!b) {
        prompt.textContent =
          'No pedal movement detected. Press it all the way down, release, then Next.';
        return;
      }
      if (s.which === 'throttle') throttle = b;
      else brake = b;
    }
    i++;
    detector = new ControlDetector(exclude());
    if (i >= steps.length) return finish();
    render();
  };

  const finish = () => {
    cancelAnimationFrame(raf);
    const base = input.gamepads.profileFor(pad0);
    const profile = buildProfile(
      id,
      steer ?? base.steer,
      throttle ?? base.throttle,
      brake ?? base.brake,
      { ...base.buttons, ...buttons },
    );
    if (!wheel) {
      profile.type = 'gamepad';
      profile.deadzone = 0.08;
      profile.steerCurve = 1.6;
    }
    input.gamepads.setProfile(profile);
    toast('Controller calibrated and saved.');
    m.close();
    done();
  };

  const loop = () => {
    const pad = navigator.getGamepads()[padIndex];
    if (pad) {
      const snap = snapshot(pad);
      detector.sample(snap);
      const s = steps[i];
      if (s.kind === 'button' && prev) {
        const b = newlyPressed(prev, snap);
        if (b !== null) {
          buttons[s.action] = b;
          advance();
        }
      }
      // Live feedback: show how much the strongest-moving control has travelled.
      const travel = Math.max(
        0,
        ...snap.axes.map((v, k) => Math.abs(v - (center?.axes[k] ?? v))),
        ...snap.buttons,
      );
      (meter.firstElementChild as HTMLElement).style.transform =
        `scaleX(${Math.min(1, travel).toFixed(3)})`;
      prev = snap;
    }
    raf = requestAnimationFrame(loop);
  };
  m.onClose = () => cancelAnimationFrame(raf);
  render();
  raf = requestAnimationFrame(loop);
}

// ---------------------------------------------------------------- Report

export function reportCard(
  r: DriveResult,
  units: Settings['units'],
  handlers: { again(): void; plan(): void },
): Modal {
  const m = new Modal(r.completed ? 'Drive complete' : 'Drive report', {
    wide: true,
    dismissable: false,
  });
  const g = grade(r.score);
  const k = units === 'mph' ? MPS_TO_MPH : MPS_TO_KPH;
  const dist =
    units === 'mph'
      ? `${(r.distance / 1609.34).toFixed(2)} mi`
      : `${(r.distance / 1000).toFixed(2)} km`;
  const mins = `${Math.floor(r.seconds / 60)}:${String(Math.floor(r.seconds % 60)).padStart(2, '0')}`;
  const counts = new Map<
    string,
    { message: string; n: number; points: number; severity: string }
  >();
  for (const e of r.events) {
    const c = counts.get(e.kind) ?? { message: e.message, n: 0, points: 0, severity: e.severity };
    c.n++;
    c.points += e.points;
    counts.set(e.kind, c);
  }
  const notes = [...counts.values()].sort((a, b) => b.points - a.points);
  m.body.append(
    el(
      'div',
      { class: 'report-head' },
      el(
        'div',
        { class: `grade grade-${g.letter[0]}` },
        el('strong', {}, g.letter),
        el('span', {}, `${r.score}/100`),
      ),
      el(
        'div',
        {},
        el('p', { class: 'verdict' }, g.verdict),
        el(
          'div',
          { class: 'stats' },
          stat(dist, 'driven'),
          stat(mins, 'time'),
          stat(`${Math.round(r.maxSpeed * k)} ${units}`, 'top speed'),
        ),
      ),
    ),
    notes.length
      ? el(
          'ul',
          { class: 'notes' },
          ...notes.map((n) =>
            el(
              'li',
              { class: `sev-${n.severity}` },
              el('span', {}, n.message),
              el('b', {}, n.n > 1 ? `×${n.n}` : ''),
              el('em', {}, n.points ? `−${n.points}` : 'tip'),
            ),
          ),
        )
      : el('p', { class: 'clean' }, 'A clean drive with no mistakes. Nicely done.'),
    el(
      'div',
      { class: 'row end' },
      el(
        'button',
        {
          class: 'btn',
          onclick: () => {
            m.close();
            handlers.plan();
          },
        },
        icon('route', 16),
        'New route',
      ),
      el(
        'button',
        {
          class: 'btn btn-primary',
          onclick: () => {
            m.close();
            handlers.again();
          },
        },
        icon('restart', 16),
        'Drive it again',
      ),
    ),
  );
  return m;
}

function stat(value: string, label: string): HTMLElement {
  return el('div', { class: 'stat' }, el('strong', {}, value), el('span', {}, label));
}
