// Ambient sound, generated in the browser with Web Audio.
//
// Deliberately synthesised rather than streamed: no network, no CDN, no
// licensing, works offline, and it never stops to buffer.
(function () {
  let ctx = null, master = null, nodes = [], playing = false, current = 'rain';

  // A few seconds of noise, looped. Brown noise (integrated white) is the
  // low-rumble base most "ambient" sounds are built from.
  function noiseBuffer(kind) {
    const len = ctx.sampleRate * 4;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      if (kind === 'white') { d[i] = white; continue; }
      last = (last + 0.02 * white) / 1.02;   // brown: integrate + leak
      d[i] = last * 3.5;
    }
    return buf;
  }

  function stopAll() {
    nodes.forEach(n => { try { n.stop ? n.stop() : n.disconnect(); } catch (e) {} });
    nodes = [];
  }

  // Each preset is noise shaped by filters. Names describe the sound, not the
  // synthesis: "fire" is amplitude-modulated noise, not a sample.
  function noiseSource(kind) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(kind || 'brown');
    src.loop = true;
    return src;
  }
  function band(type, freq, q) {
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq;
    if (q != null) f.Q.value = q;
    return f;
  }
  // A slow oscillator swept across a filter parameter - what makes a static
  // noise bed feel like it is breathing.
  function sweep(param, rate, depth, centre) {
    const lfo = ctx.createOscillator(); lfo.frequency.value = rate;
    const gain = ctx.createGain(); gain.gain.value = depth;
    lfo.connect(gain); gain.connect(param);
    if (centre != null) param.value = centre;
    lfo.start();
    nodes.push(lfo);
    return lfo;
  }
  function chain(src, filters) {
    let node = src;
    filters.forEach(f => { node.connect(f); node = f; });
    node.connect(master);
    src.start();
    nodes.push(src);
  }

  const PRESETS = {
    rain() {
      chain(noiseSource('brown'), [band('highpass', 400), band('lowpass', 6200)]);
    },
    waves() {
      const lp = band('lowpass', 700);
      chain(noiseSource('brown'), [lp]);
      sweep(lp.frequency, 0.09, 420, 700);
    },
    wind() {
      const bp = band('bandpass', 500, 0.7);
      chain(noiseSource('brown'), [bp]);
      sweep(bp.frequency, 0.06, 320, 520);
    },
    stream() {
      chain(noiseSource('white'), [band('highpass', 1100), band('lowpass', 8000)]);
    },
    forest() {
      const bp = band('bandpass', 2400, 1.2);
      chain(noiseSource('white'), [band('highpass', 900), bp]);
      sweep(bp.frequency, 0.13, 700, 2400);
    },
    fire() {
      // Crackle: noise gated by an irregular gain, so it pops rather than hisses.
      const src = noiseSource('brown');
      const lp = band('lowpass', 1800);
      const g = ctx.createGain(); g.gain.value = 0.35;
      src.connect(lp); lp.connect(g); g.connect(master);
      src.start(); nodes.push(src);
      const tick = setInterval(() => {
        if (!playing) return;
        const t = ctx.currentTime;
        g.gain.cancelScheduledValues(t);
        g.gain.setValueAtTime(g.gain.value, t);
        g.gain.linearRampToValueAtTime(0.25 + Math.random() * 0.7, t + 0.04 + Math.random() * 0.1);
      }, 110);
      nodes.push({ stop: () => clearInterval(tick), disconnect: () => clearInterval(tick) });
    },
    deep() {
      chain(noiseSource('brown'), [band('lowpass', 260)]);
    },
    hush() {
      chain(noiseSource('brown'), [band('lowpass', 1400), band('highpass', 120)]);
    },
    white() {
      chain(noiseSource('white'), [band('lowpass', 11000)]);
    },
  };

  window.AmbientAudio = {
    presets: Object.keys(PRESETS),
    get playing() { return playing; },
    get preset() { return current; },
    play(name) {
      if (!ctx) {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        master = ctx.createGain();
        master.gain.value = 0.0001;
        master.connect(ctx.destination);
      }
      if (ctx.state === 'suspended') ctx.resume();
      stopAll();
      current = name || current;
      (PRESETS[current] || PRESETS.rain)();
      playing = true;
      this.fadeTo(Number(localStorage.getItem('vol') ?? 0.35));
    },
    stop() {
      if (!ctx) return;
      this.fadeTo(0.0001, 0.4);
      setTimeout(stopAll, 450);
      playing = false;
    },
    // Ramps rather than jumps: a step change in gain clicks audibly.
    fadeTo(v, seconds) {
      if (!master) return;
      const target = Math.max(0.0001, Math.min(1, v));
      master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.setValueAtTime(Math.max(0.0001, master.gain.value), ctx.currentTime);
      master.gain.exponentialRampToValueAtTime(target, ctx.currentTime + (seconds || 0.25));
    },
    setVolume(v) {
      localStorage.setItem('vol', String(v));
      if (playing) this.fadeTo(v, 0.1);
    },
  };
})();
