import { Gear, GEAR_ORDER } from '../sim/transmission';
import { CoachEvent } from '../sim/coach';
import { TouchState } from '../input/input';
import { el, icon } from './dom';

export interface HudData {
  speed: number;
  units: string;
  limit: number | null;
  gear: Gear;
  rpm: number;
  throttle: number;
  brake: number;
  steer: number;
  signal: 'left' | 'right' | 'hazard' | null;
  blinkOn: boolean;
  glyph: string;
  navDistance: string;
  navInstruction: string;
  score: number;
  progress: number;
  attribution: string;
  device: string;
  /** Upcoming stop sign or traffic light, if any. */
  control: { kind: 'stop' | 'green' | 'yellow' | 'red'; distance: string } | null;
}

export interface HudCallbacks {
  onGear(g: Gear): void;
  onSignal(side: 'left' | 'right'): void;
  onPause(): void;
  onCamera(): void;
  onMute(): void;
  onVR(): void;
  onSettings(): void;
}

/** The on-screen driving display: navigation, speed, gear, pedals, coaching. */
export class Hud {
  readonly root: HTMLElement;
  readonly minimapHost: HTMLElement;
  private readonly speed = el('span', { class: 'speed-value' }, '0');
  private readonly units = el('span', { class: 'speed-units' }, 'mph');
  private readonly limit = el(
    'div',
    { class: 'limit-sign', hidden: true },
    el('small', {}, 'SPEED LIMIT'),
    el('strong', {}, '--'),
  );
  private readonly gears = new Map<Gear, HTMLButtonElement>();
  private readonly throttleBar = el('i', {});
  private readonly brakeBar = el('i', {});
  private readonly steerDot = el('i', {});
  private readonly sigLeft = el(
    'button',
    { class: 'signal signal-left', 'aria-label': 'Left turn signal' },
    '◀',
  );
  private readonly sigRight = el(
    'button',
    { class: 'signal signal-right', 'aria-label': 'Right turn signal' },
    '▶',
  );
  private readonly navGlyph = el('div', { class: 'nav-glyph' }, '↑');
  private readonly navDist = el('div', { class: 'nav-distance' }, '');
  private readonly navText = el('div', { class: 'nav-text' }, '');
  private readonly score = el('strong', {}, '100');
  private readonly progress = el('i', {});
  private readonly coach = el('div', { class: 'coach', 'aria-live': 'polite' });
  private readonly attrib = el('div', { class: 'hud-attrib' });
  private readonly device = el('span', { class: 'device-chip' });
  private readonly banner = el('div', { class: 'hud-banner', hidden: true });
  private readonly controlChip = el('div', { class: 'control-chip glass', hidden: true });
  private lastControl = '';
  private readonly muteBtn: HTMLButtonElement;
  readonly vrBtn: HTMLButtonElement;
  touch: TouchState | null = null;

  constructor(cb: HudCallbacks, vrAvailable: boolean) {
    const gearBox = el('div', {
      class: 'gear-select',
      role: 'group',
      'aria-label': 'Gear selector',
    });
    for (const g of GEAR_ORDER) {
      const b = el('button', { class: 'gear', 'aria-label': gearName(g) }, g);
      onPress(b, () => cb.onGear(g));
      this.gears.set(g, b);
      gearBox.append(b);
    }
    onPress(this.sigLeft, () => cb.onSignal('left'));
    onPress(this.sigRight, () => cb.onSignal('right'));

    this.muteBtn = toolBtn('volume', 'Mute (M)', cb.onMute);
    this.vrBtn = toolBtn('vr', 'Enter VR', cb.onVR);
    this.vrBtn.hidden = !vrAvailable;
    this.minimapHost = el('div', { class: 'minimap', 'aria-label': 'Minimap' });

    this.root = el(
      'div',
      { class: 'hud' },
      el(
        'div',
        { class: 'hud-top' },
        el(
          'div',
          { class: 'score-pill glass' },
          el('span', {}, 'Score'),
          this.score,
          el('div', { class: 'progress' }, this.progress),
        ),
        el(
          'div',
          { class: 'nav-banner glass' },
          this.navGlyph,
          el('div', {}, this.navDist, this.navText),
        ),
        el(
          'div',
          { class: 'toolbar glass' },
          toolBtn('camera', 'Change camera (C)', cb.onCamera),
          this.muteBtn,
          this.vrBtn,
          toolBtn('settings', 'Settings', cb.onSettings),
          toolBtn('pause', 'Pause (Esc)', cb.onPause),
        ),
      ),
      this.minimapHost,
      this.controlChip,
      this.coach,
      this.banner,
      el(
        'div',
        { class: 'hud-bottom' },
        el(
          'div',
          { class: 'speedo glass' },
          el('div', { class: 'speed-row' }, this.speed, this.units),
          this.limit,
        ),
        el(
          'div',
          { class: 'controls glass' },
          el('div', { class: 'signals' }, this.sigLeft, this.sigRight),
          el(
            'div',
            { class: 'pedals', 'aria-hidden': 'true' },
            el('div', { class: 'pedal pedal-brake' }, this.brakeBar, el('span', {}, 'Brake')),
            el('div', { class: 'steer-meter' }, this.steerDot),
            el('div', { class: 'pedal pedal-gas' }, this.throttleBar, el('span', {}, 'Gas')),
          ),
          this.device,
        ),
        el(
          'div',
          { class: 'gearbox glass' },
          gearBox,
          el('p', { class: 'gear-hint' }, 'R / F to shift'),
        ),
      ),
      this.attrib,
    );
    if (matchMedia('(pointer: coarse)').matches) this.addTouchControls();
  }

  update(d: HudData): void {
    this.speed.textContent = String(Math.round(Math.abs(d.speed)));
    this.units.textContent = d.units;
    if (d.limit !== null) {
      this.limit.hidden = false;
      this.limit.lastElementChild!.textContent = String(Math.round(d.limit));
      this.limit.classList.toggle('over', Math.abs(d.speed) > d.limit + 5);
    } else this.limit.hidden = true;
    for (const [g, b] of this.gears) {
      b.classList.toggle('active', g === d.gear);
      b.setAttribute('aria-pressed', String(g === d.gear));
    }
    this.throttleBar.style.transform = `scaleY(${d.throttle.toFixed(3)})`;
    this.brakeBar.style.transform = `scaleY(${d.brake.toFixed(3)})`;
    this.steerDot.style.transform = `translateX(${(d.steer * 50).toFixed(1)}%)`;
    const l = d.blinkOn && (d.signal === 'left' || d.signal === 'hazard');
    const r = d.blinkOn && (d.signal === 'right' || d.signal === 'hazard');
    this.sigLeft.classList.toggle('on', l);
    this.sigRight.classList.toggle('on', r);
    this.sigLeft.classList.toggle('armed', d.signal === 'left' || d.signal === 'hazard');
    this.sigRight.classList.toggle('armed', d.signal === 'right' || d.signal === 'hazard');
    this.navGlyph.textContent = d.glyph;
    this.navDist.textContent = d.navDistance;
    this.navText.textContent = d.navInstruction;
    this.score.textContent = String(d.score);
    this.progress.style.transform = `scaleX(${d.progress.toFixed(4)})`;
    this.attrib.textContent = d.attribution;
    this.device.textContent = d.device;
    const key = d.control ? `${d.control.kind}|${d.control.distance}` : '';
    if (key !== this.lastControl) {
      this.lastControl = key;
      this.controlChip.hidden = !d.control;
      if (d.control) {
        const icon =
          d.control.kind === 'stop'
            ? el('span', { class: 'stop-icon' }, 'STOP')
            : el(
                'span',
                { class: 'light-icon' },
                ...(['red', 'yellow', 'green'] as const).map((c) =>
                  el('i', { class: c === d.control!.kind ? `on ${c}` : '' }),
                ),
              );
        this.controlChip.replaceChildren(
          icon,
          el(
            'span',
            {},
            d.control.kind === 'stop' ? 'Stop sign' : 'Traffic light',
            el('b', {}, ` ${d.control.distance}`),
          ),
        );
      }
    }
  }

  setMuted(muted: boolean): void {
    this.muteBtn.replaceChildren(icon(muted ? 'mute' : 'volume', 18));
  }

  /** A persistent message, e.g. "Press the brake and shift into Drive to begin". */
  setBanner(text: string | null): void {
    this.banner.hidden = !text;
    this.banner.textContent = text ?? '';
  }

  showEvent(
    e: CoachEvent | { message: string; severity: 'tip' | 'minor' | 'major'; points?: number },
  ): void {
    const item = el(
      'div',
      { class: `coach-item sev-${e.severity}` },
      el('span', { class: 'coach-dot' }),
      el('span', {}, e.message),
      e.points ? el('b', {}, `−${e.points}`) : null,
    );
    this.coach.prepend(item);
    while (this.coach.children.length > 3) this.coach.lastElementChild?.remove();
    setTimeout(() => {
      item.classList.add('out');
      setTimeout(() => item.remove(), 400);
    }, 5000);
  }

  private addTouchControls(): void {
    const state: TouchState = { throttle: 0, brake: 0, steer: 0 };
    this.touch = state;
    const pedal = (label: string, key: 'throttle' | 'brake') => {
      const b = el('button', { class: `touch-pedal touch-${key}` }, label);
      // Track each finger on the pedal and capture it, so the pedal stays held
      // while the finger drifts and while other fingers tap the gear selector.
      const fingers = new Set<number>();
      const sync = () => {
        state[key] = fingers.size ? 1 : 0;
        b.classList.toggle('held', fingers.size > 0);
      };
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        fingers.add(e.pointerId);
        b.setPointerCapture?.(e.pointerId);
        sync();
      });
      const lift = (e: PointerEvent) => {
        fingers.delete(e.pointerId);
        sync();
      };
      b.addEventListener('pointerup', lift);
      b.addEventListener('pointercancel', lift);
      b.addEventListener('lostpointercapture', lift);
      b.addEventListener('contextmenu', (e) => e.preventDefault());
      return b;
    };
    const pad = el('div', { class: 'touch-steer' }, el('span', {}, 'Drag to steer'));
    let startX = 0;
    pad.addEventListener('pointerdown', (e) => {
      startX = e.clientX;
      pad.setPointerCapture(e.pointerId);
    });
    pad.addEventListener('pointermove', (e) => {
      if (!pad.hasPointerCapture(e.pointerId)) return;
      state.steer = Math.max(-1, Math.min(1, (e.clientX - startX) / 120));
    });
    const release = () => (state.steer = 0);
    pad.addEventListener('pointerup', release);
    pad.addEventListener('pointercancel', release);
    this.root.append(
      el(
        'div',
        { class: 'touch-controls' },
        pad,
        el('div', { class: 'touch-pedals' }, pedal('Brake', 'brake'), pedal('Gas', 'throttle')),
      ),
    );
  }
}

/**
 * Fires on touch-down for fingers and pens, and on click for mice and the
 * keyboard. Mobile browsers often drop `click` for a tap made while another
 * finger is already down (e.g. holding the brake while tapping D), but they
 * always deliver `pointerdown`.
 */
function onPress(b: HTMLElement, fn: () => void): void {
  let touchedAt = -Infinity;
  b.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    e.preventDefault();
    touchedAt = performance.now();
    fn();
  });
  b.addEventListener('click', () => {
    if (performance.now() - touchedAt < 800) return; // already handled on touch-down
    fn();
  });
}

function toolBtn(name: string, label: string, fn: () => void): HTMLButtonElement {
  return el(
    'button',
    { class: 'icon-btn', title: label, 'aria-label': label, onclick: fn },
    icon(name, 18),
  );
}

function gearName(g: Gear): string {
  return { P: 'Park', R: 'Reverse', N: 'Neutral', D: 'Drive' }[g];
}
