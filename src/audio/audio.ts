/**
 * All sound is synthesised with the Web Audio API, so the project ships no
 * audio assets: an engine whose pitch follows RPM, tyre/road noise that grows
 * with speed, the indicator click, a horn and coaching chimes.
 */
export class CarAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private engineGain!: GainNode;
  private engineOsc: OscillatorNode[] = [];
  private engineFilter!: BiquadFilterNode;
  private roadGain!: GainNode;
  private roadFilter!: BiquadFilterNode;
  private hornGain!: GainNode;
  private muted = false;
  private volume = 0.7;

  /** Must be called from a user gesture (browser autoplay rules). */
  start(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    this.master.connect(ctx.destination);

    // Engine: a few detuned harmonics through a low-pass filter.
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 600;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0.05;
    this.engineFilter.connect(this.engineGain).connect(this.master);
    for (const [type, mult, gain] of [
      ['sawtooth', 1, 0.5],
      ['triangle', 2, 0.35],
      ['square', 0.5, 0.2],
    ] as const) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = 30 * mult;
      const g = ctx.createGain();
      g.gain.value = gain;
      osc.connect(g).connect(this.engineFilter);
      osc.start();
      this.engineOsc.push(osc);
    }

    // Road and wind noise: filtered white noise.
    const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    this.roadFilter = ctx.createBiquadFilter();
    this.roadFilter.type = 'bandpass';
    this.roadFilter.frequency.value = 400;
    this.roadFilter.Q.value = 0.6;
    this.roadGain = ctx.createGain();
    this.roadGain.gain.value = 0;
    src.connect(this.roadFilter).connect(this.roadGain).connect(this.master);
    src.start();

    // Horn: two square waves a musical third apart, like a real dual-tone horn.
    this.hornGain = ctx.createGain();
    this.hornGain.gain.value = 0;
    const hornFilter = ctx.createBiquadFilter();
    hornFilter.type = 'lowpass';
    hornFilter.frequency.value = 2200;
    hornFilter.connect(this.hornGain).connect(this.master);
    for (const f of [415, 523]) {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = f;
      o.connect(hornFilter);
      o.start();
    }
  }

  update(rpm: number, throttle: number, speed: number, horn: boolean): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    // Four-cylinder firing frequency: rpm / 60 * 2.
    const base = (rpm / 60) * 2;
    this.engineOsc.forEach((o, i) => o.frequency.setTargetAtTime(base * [1, 2, 0.5][i], t, 0.05));
    this.engineFilter.frequency.setTargetAtTime(400 + throttle * 1400 + rpm * 0.15, t, 0.08);
    this.engineGain.gain.setTargetAtTime(0.035 + throttle * 0.06, t, 0.1);
    const v = Math.abs(speed);
    this.roadGain.gain.setTargetAtTime(Math.min(v / 30, 1) * 0.16, t, 0.2);
    this.roadFilter.frequency.setTargetAtTime(250 + v * 25, t, 0.2);
    this.hornGain.gain.setTargetAtTime(horn ? 0.12 : 0, t, 0.015);
  }

  /** The relay click of a turn signal. */
  tick(on: boolean): void {
    this.blip(on ? 2400 : 1700, 0.012, 0.18, 'square');
  }

  /** Two-note chime for coaching messages. Majors sound lower and longer. */
  chime(severity: 'tip' | 'minor' | 'major'): void {
    const [a, b] =
      severity === 'major' ? [660, 440] : severity === 'minor' ? [880, 660] : [988, 1319];
    this.blip(a, 0.14, 0.12, 'sine');
    setTimeout(() => this.blip(b, 0.2, 0.12, 'sine'), 140);
  }

  /** Short buzz when a shift is refused. */
  deny(): void {
    this.blip(180, 0.18, 0.15, 'sawtooth');
  }

  private blip(freq: number, dur: number, gain: number, type: OscillatorType): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.ctx) this.master.gain.value = muted ? 0 : this.volume;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  suspend(): void {
    void this.ctx?.suspend();
  }

  resume(): void {
    void this.ctx?.resume();
  }
}
