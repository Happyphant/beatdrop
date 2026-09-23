/**
 * BeatDrop — Sound Engine
 * Синтез звуков через Web Audio API (без семплов)
 */

let _sfxCtx = null;

function getSfxCtx() {
  if (!_sfxCtx || _sfxCtx.state === 'closed') {
    _sfxCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (_sfxCtx.state === 'suspended') {
    _sfxCtx.resume();
  }
  return _sfxCtx;
}

// ── HELPERS ──────────────────────────────────────────────────

function playTone({ freq = 440, type = 'sine', gain = 0.25, attack = 0.005,
                    decay = 0.08, sustain = 0.0, release = 0.06,
                    duration = 0.15, detune = 0, freqEnd = null } = {}) {
  const ctx = getSfxCtx();
  const now = ctx.currentTime;

  const osc = ctx.createOscillator();
  const env = ctx.createGain();

  osc.type = type;
  osc.frequency.setValueAtTime(freq, now);
  osc.detune.setValueAtTime(detune, now);
  if (freqEnd !== null) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(freqEnd, 1), now + duration);
  }

  // ADSR envelope
  env.gain.setValueAtTime(0, now);
  env.gain.linearRampToValueAtTime(gain, now + attack);
  env.gain.linearRampToValueAtTime(gain * sustain || gain * 0.3, now + attack + decay);
  env.gain.linearRampToValueAtTime(0, now + attack + decay + release);

  osc.connect(env);
  env.connect(ctx.destination);
  osc.start(now);
  osc.stop(now + attack + decay + release + 0.01);
}

function playNoise({ gain = 0.15, attack = 0.001, decay = 0.05, highpass = 2000 } = {}) {
  const ctx = getSfxCtx();
  const now = ctx.currentTime;
  const bufSize = Math.ceil(ctx.sampleRate * (decay + 0.05));
  const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;

  const src = ctx.createBufferSource();
  src.buffer = buf;

  const filter = ctx.createBiquadFilter();
  filter.type = 'highpass';
  filter.frequency.value = highpass;

  const env = ctx.createGain();
  env.gain.setValueAtTime(gain, now);
  env.gain.exponentialRampToValueAtTime(0.001, now + decay);

  src.connect(filter);
  filter.connect(env);
  env.connect(ctx.destination);
  src.start(now);
}

// ── PUBLIC API ────────────────────────────────────────────────

export function soundPerfect() {
  // Same shape as Good but louder (+35%)
  playTone({ freq: 550, type: 'sine', gain: 0.22, attack: 0.004, decay: 0.07, release: 0.06, freqEnd: 620 });
}

export function soundGood() {
  // Softer single note, slight rise
  playTone({ freq: 550, type: 'sine', gain: 0.16, attack: 0.004, decay: 0.07, release: 0.06, freqEnd: 620 });
}

export function soundMiss() {
  // Low thud + filtered noise — brief, non-annoying
  playTone({ freq: 120, type: 'sine', gain: 0.20, attack: 0.002, decay: 0.04, release: 0.07, freqEnd: 60 });
  playNoise({ gain: 0.08, decay: 0.04, highpass: 800 });
}

export function soundMenuClick() {
  playTone({ freq: 660, type: 'sine', gain: 0.12, attack: 0.002, decay: 0.04, release: 0.04 });
}

export function soundRankReveal(rank) {
  // Higher rank = more triumphant
  const freqs = { SS: [880, 1100, 1320], S: [660, 880, 1100], A: [550, 660, 880],
                  B: [440, 550, 660], C: [330, 440, 550], D: [220, 330] };
  const notes = freqs[rank] || freqs['D'];
  notes.forEach((f, i) => {
    setTimeout(() => {
      playTone({ freq: f, type: 'sine', gain: 0.18 - i * 0.03, attack: 0.01, decay: 0.12, release: 0.15 });
    }, i * 90);
  });
}

export function unlockSfxCtx() {
  getSfxCtx(); // creates + auto-resumes
}
