import { TUNING } from "./config.js";

/**
 * A tiny generative soundscape: filtered brown noise for water, a low pressure
 * rumble, occasional far dolphin clicks, and transient splash/whoosh events.
 * No samples, no network requests, and it only starts from a user gesture.
 */
export class OceanAudio {
  constructor() {
    this.ctx = null;
    this.started = false;
    this.master = null;
    this.filter = null;
    this.ambientGain = null;
    this.rumbleGain = null;
    this.flowGain = null;
    this.reverb = null;
    this.chirpTimer = 6 + Math.random() * 8;
    this.enabled = true;
    this.time = 0;
  }

  /**
   * Build the audio graph and its noise buffers during the loading screen.
   * The context stays suspended until the player gesture in start(); this
   * keeps the first interactive frame from paying for several seconds of
   * buffer generation and WebAudio setup.
   */
  prepare() {
    if (this.ctx) return;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    try {
      const ctx = new AudioCtx();
      this.ctx = ctx;
      this._buildGraph(ctx);
    } catch (err) {
      this.ctx = null;
      this.started = false;
      console.warn("Ocean audio unavailable.", err);
    }
  }

  _buildGraph(ctx) {
      const master = ctx.createGain();
      master.gain.value = TUNING.audio.master;
      master.connect(ctx.destination);
      this.master = master;

      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -22;
      comp.knee.value = 22;
      comp.ratio.value = 5;
      comp.attack.value = 0.03;
      comp.release.value = 1.0;
      comp.connect(master);

      this.bus = ctx.createGain();
      this.bus.gain.value = 0.9;
      this.bus.connect(comp);

      const impulseLen = Math.floor(ctx.sampleRate * 2.4);
      const impulse = ctx.createBuffer(2, impulseLen, ctx.sampleRate);
      for (let c = 0; c < 2; c++) {
        const data = impulse.getChannelData(c);
        for (let i = 0; i < impulseLen; i++) {
          const t = i / impulseLen;
          data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 3.4) * 0.7;
        }
      }
      const reverb = ctx.createConvolver();
      reverb.buffer = impulse;
      const reverbGain = ctx.createGain();
      reverbGain.gain.value = 0.34;
      reverb.connect(reverbGain);
      reverbGain.connect(this.bus);
      this.reverb = reverb;

      const noise = this._noiseBuffer(7);
      const amb = ctx.createBufferSource();
      amb.buffer = noise;
      amb.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 720;
      filter.Q.value = 0.35;
      const gain = ctx.createGain();
      gain.gain.value = 0.0;
      amb.connect(filter);
      filter.connect(gain);
      gain.connect(this.bus);
      amb.start();
      this.filter = filter;
      this.ambientGain = gain;

      const rumbleNoise = this._noiseBuffer(9);
      const rumbleSrc = ctx.createBufferSource();
      rumbleSrc.buffer = rumbleNoise;
      rumbleSrc.loop = true;
      const rumbleFilter = ctx.createBiquadFilter();
      rumbleFilter.type = "lowpass";
      rumbleFilter.frequency.value = 90;
      const rumbleGain = ctx.createGain();
      rumbleGain.gain.value = 0.2;
      rumbleSrc.connect(rumbleFilter);
      rumbleFilter.connect(rumbleGain);
      rumbleGain.connect(this.bus);
      rumbleSrc.start();
      this.rumbleGain = rumbleGain;

      // A high, glassy layer for the surface — audible only when the camera
      // breaks through.
      const flowSrc = ctx.createBufferSource();
      flowSrc.buffer = this._noiseBuffer(5);
      flowSrc.loop = true;
      const flowFilter = ctx.createBiquadFilter();
      flowFilter.type = "bandpass";
      flowFilter.frequency.value = 2300;
      flowFilter.Q.value = 0.5;
      const flowGain = ctx.createGain();
      flowGain.gain.value = 0.0;
      flowSrc.connect(flowFilter);
      flowFilter.connect(flowGain);
      flowGain.connect(this.bus);
      flowSrc.start();
      this.flowGain = flowGain;

      gain.gain.setTargetAtTime(0.2, ctx.currentTime, 1.8);
  }

  async start() {
    if (!this.ctx) this.prepare();
    if (!this.ctx) return;
    try {
      await this.ctx.resume();
      this.started = true;
    } catch (err) {
      console.warn("Ocean audio unavailable.", err);
    }
  }

  _noiseBuffer(seconds) {
    const ctx = this.ctx;
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      last = last * 0.98 + white * 0.02;
      data[i] = last * 3.2 + white * 0.1;
    }
    return buffer;
  }

  update(dt, state) {
    if (!this.started || !this.ctx) return;
    this.time += dt;
    const under = state.underwater ?? 1;
    const depth = Math.max(0, state.depth ?? 4);
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const live = this.enabled ? 1 : 0;

    const cutoff = 420 + (1 - under) * 5800 - Math.min(depth, 30) * 5;
    this.filter.frequency.setTargetAtTime(Math.max(180, cutoff), now, 0.25);
    this.ambientGain.gain.setTargetAtTime(0.22 * live * (0.65 + under * 0.35), now, 0.8);
    this.rumbleGain.gain.setTargetAtTime((0.12 + under * 0.08) * live, now, 1.2);
    this.flowGain.gain.setTargetAtTime((1 - under) * 0.055 * live, now, 0.4);

    this.chirpTimer -= dt;
    if (this.chirpTimer <= 0) {
      this.chirpTimer = 7 + Math.random() * 15;
      if (Math.random() > 0.35) this._chirp();
    }
  }

  _chirp() {
    if (!this.ctx || !this.enabled) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const pan = ctx.createStereoPanner();
    pan.pan.value = (Math.random() - 0.5) * 1.4;
    const start = 1700 + Math.random() * 4200;
    const len = 0.045 + Math.random() * 0.14;
    osc.type = "sine";
    osc.frequency.setValueAtTime(start, now);
    osc.frequency.exponentialRampToValueAtTime(start * (0.45 + Math.random() * 0.9), now + len);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.15, now + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + len);
    osc.connect(gain);
    gain.connect(pan);
    pan.connect(this.bus);
    pan.connect(this.reverb);
    osc.start(now);
    osc.stop(now + len + 0.03);

    if (Math.random() > 0.56) {
      setTimeout(() => this._chirp(), 80 + Math.random() * 190);
    }
  }

  event(name, intensity = 1) {
    if (!this.started || !this.enabled || !this.ctx) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    if (name === "splash" || name === "breach") {
      const src = ctx.createBufferSource();
      src.buffer = this._noiseBuffer(1.5);
      const filter = ctx.createBiquadFilter();
      filter.type = "bandpass";
      filter.frequency.setValueAtTime(name === "breach" ? 1800 : 900, now);
      filter.frequency.exponentialRampToValueAtTime(240, now + 0.9);
      filter.Q.value = 0.7;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.3 * Math.min(1.4, intensity), now + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.1);
      src.connect(filter);
      filter.connect(gain);
      gain.connect(this.bus);
      gain.connect(this.reverb);
      src.start(now);
      src.stop(now + 1.2);

      for (let i = 0; i < 5 + intensity * 5; i++) {
        this._bubble(now + Math.random() * 0.7, 0.05 + Math.random() * 0.05);
      }
    } else if (name === "impact") {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(95, now);
      osc.frequency.exponentialRampToValueAtTime(38, now + 0.32);
      gain.gain.setValueAtTime(0.15 * intensity, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.42);
      osc.connect(gain);
      gain.connect(this.bus);
      osc.start(now);
      osc.stop(now + 0.45);
    } else if (name === "whoosh") {
      const src = ctx.createBufferSource();
      src.buffer = this._noiseBuffer(1.1);
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 500;
      bp.Q.value = 0.5;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.045 * intensity, now + 0.2);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.9);
      src.connect(bp);
      bp.connect(gain);
      gain.connect(this.bus);
      src.start(now);
      src.stop(now + 1);
    }
  }

  _bubble(at, vol) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(300 + Math.random() * 900, at);
    osc.frequency.exponentialRampToValueAtTime(900 + Math.random() * 1900, at + 0.05);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(vol, at + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.08);
    osc.connect(gain);
    gain.connect(this.bus);
    osc.start(at);
    osc.stop(at + 0.1);
  }

  toggle() {
    this.enabled = !this.enabled;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this.enabled ? TUNING.audio.master : 0, this.ctx.currentTime, 0.2);
    }
    return this.enabled;
  }
}
