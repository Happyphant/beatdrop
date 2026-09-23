/**
 * BeatDrop — основной модуль игры
 * 2D Canvas ритм-игра с генерацией beatmap из MP3
 */

import { analyzeAudio } from './audio-analyzer.js';
import { soundPerfect, soundGood, soundMiss, soundMenuClick, soundRankReveal, unlockSfxCtx } from './sound.js';
import { randomName, getScores, addScore, isHighScore } from './leaderboard.js';

// ── КОНСТАНТЫ ────────────────────────────────────────────────
const LANE_COUNT = 4;
const LANE_COLORS = ['#f97316', '#eab308', '#22c55e', '#3b82f6'];
const LANE_KEYS   = ['KeyD', 'KeyF', 'KeyJ', 'KeyK'];
const LANE_LABELS = ['D', 'F', 'J', 'K'];

const SCROLL_SPEED_BASE = 400; // px/s при 1.0x
const HIT_ZONE_Y_RATIO  = 0.88; // % от высоты canvas
const HIT_WINDOW_PERFECT = 0.09; // s (wider — easier to hit perfect)
const HIT_WINDOW_GOOD    = 0.12; // s
const HIT_WINDOW_MISS    = 0.20; // s (после этого — авто-miss)

const NOTE_W = 50;
const NOTE_H = 18;
const NOTE_RADIUS = 9;

const SCORE_PERFECT = 300;
const SCORE_GOOD    = 100;
const SCORE_MISS    = 0;

// ── STATE ─────────────────────────────────────────────────────
let state = {
  phase: 'menu', // menu | analyzing | playing | paused | results
  songName: '',
  songDuration: 0,
  bpm: 120,
  beatmap: [],     // [{ time, lane, hit: false, missed: false }]
  notes: [],       // активные на экране ноты

  score: 0,
  combo: 0,
  maxCombo: 0,
  totalNotes: 0,
  hits: { perfect: 0, good: 0, miss: 0 },

  currentTime: 0,  // текущее время в треке (s)
  startTimestamp: 0, // performance.now() когда запущено
  pauseOffset: 0,  // накопленное время на паузах
  pauseStart: 0,

  audioCtx: null,
  audioSource: null,
  audioBuffer: null,

  scrollSpeed: SCROLL_SPEED_BASE,
  laneWidth: 120,
  laneStartX: 0,
  hitZoneY: 0,

  keyState: {},
  judgements: [],  // float-up текст
  flashes: [],    // note hit flash particles

  frameCount: 0,
  lastFps: 60,
  fpsTimer: 0,
  fpsAccum: 0,
};

// ── DOM ──────────────────────────────────────────────────────
const canvas     = document.getElementById('gameCanvas');
const ctx        = canvas.getContext('2d');
const screens    = {
  welcome:     document.getElementById('screen-welcome'),
  analyzing:   document.getElementById('screen-analyzing'),
  game:        document.getElementById('screen-game'),
  pause:       document.getElementById('screen-pause'),
  results:     document.getElementById('screen-results'),
  name:        document.getElementById('screen-name'),
  leaderboard: document.getElementById('screen-leaderboard'),
};
const els = {
  dropZone:      document.getElementById('drop-zone'),
  fileInput:     document.getElementById('file-input'),
  dropOverlay:   document.getElementById('drop-overlay'),
  analyzeProgress: document.getElementById('analyze-progress'),
  analyzeDetail:   document.getElementById('analyze-detail'),
  hudScore:      document.getElementById('hud-score'),
  hudCombo:      document.getElementById('hud-combo'),
  hudAccuracy:   document.getElementById('hud-accuracy'),
  hudProgress:   document.getElementById('hud-progress'),
  hudSong:       document.getElementById('hud-song'),
  debugOverlay:  document.getElementById('debug-overlay'),
  pauseBtn:      document.getElementById('pause-btn'),
  btnResume:     document.getElementById('btn-resume'),
  btnRestart:    document.getElementById('btn-restart'),
  btnMenuFromPause: document.getElementById('btn-menu-from-pause'),
  btnRetry:      document.getElementById('btn-retry'),
  btnMenu:       document.getElementById('btn-menu'),
  keyInds:       document.querySelectorAll('.key-ind'),
  resScore:      document.getElementById('res-score'),
  resAccuracy:   document.getElementById('res-accuracy'),
  resCombo:      document.getElementById('res-combo'),
  resPerfect:    document.getElementById('res-perfect'),
  resGood:       document.getElementById('res-good'),
  resMiss:       document.getElementById('res-miss'),
  resultsRank:   document.getElementById('results-rank'),
  resultsTitle:  document.getElementById('results-title'),
  btnLeaderboard: document.getElementById('btn-leaderboard'),
  // Name entry
  playerNameInput: document.getElementById('player-name-input'),
  nameDiceBtn:   document.getElementById('name-dice-btn'),
  btnSaveScore:  document.getElementById('btn-save-score'),
  btnSkipScore:  document.getElementById('btn-skip-score'),
  nameRank:      document.getElementById('name-rank'),
  nameScoreVal:  document.getElementById('name-score-val'),
  // Leaderboard
  lbTable:       document.getElementById('lb-table'),
  lbClearBtn:    document.getElementById('lb-clear-btn'),
  lbRetryBtn:    document.getElementById('lb-retry-btn'),
  lbMenuBtn:     document.getElementById('lb-menu-btn'),
  lbWelcomeBtn:  document.getElementById('lb-welcome-btn'),
};

// ── SCREEN MANAGEMENT ────────────────────────────────────────
function showScreen(name) {
  Object.entries(screens).forEach(([k, el]) => el.classList.toggle('active', k === name));
}

// ── LAYOUT ───────────────────────────────────────────────────
function resizeCanvas() {
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
  // On mobile: lanes fill full width. On desktop: capped at 640px centered.
  const mobileW = canvas.width <= 600;
  const targetTotalW = mobileW
    ? canvas.width  // full width on mobile
    : Math.min(canvas.width * 0.55, 640);
  state.laneWidth = Math.floor(targetTotalW / LANE_COUNT);
  const totalW = state.laneWidth * LANE_COUNT;
  state.laneStartX = (canvas.width - totalW) / 2;
  // On mobile hit zone slightly higher to leave room for tap area below
  state.hitZoneY = canvas.height * (mobileW ? 0.75 : HIT_ZONE_Y_RATIO);

  // Scale scroll speed to screen height so note travel time stays ~1.8s
  state.scrollSpeed = state.hitZoneY / 1.8;

  // Обновить CSS переменную для key indicators
  els.keyInds.forEach(ind => {
    ind.style.width = state.laneWidth + 'px';
  });
  document.querySelector('.key-indicators').style.left = state.laneStartX + 'px';
  document.querySelector('.key-indicators').style.transform = 'none';
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// ── FILE HANDLING ────────────────────────────────────────────
function setupDropZone() {
  const dz = els.dropZone;
  const overlay = els.dropOverlay;

  dz.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', e => {
    if (e.target.files[0]) loadFile(e.target.files[0]);
  });

  // Drag events on the whole window
  window.addEventListener('dragenter', e => { e.preventDefault(); overlay.classList.remove('hidden'); });
  window.addEventListener('dragleave', e => {
    if (!e.relatedTarget || e.relatedTarget === document.documentElement) {
      overlay.classList.add('hidden');
    }
  });
  window.addEventListener('dragover', e => { e.preventDefault(); });
  window.addEventListener('drop', e => {
    e.preventDefault();
    overlay.classList.add('hidden');
    const file = e.dataTransfer.files[0];
    if (file) loadFile(file);
  });

  // Drop zone specific hover
  dz.addEventListener('dragover', () => dz.classList.add('drag-over'));
  dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
}

async function loadFile(file) {
  if (!file.type.startsWith('audio/')) {
    alert('Пожалуйста, выберите аудиофайл (MP3, WAV, OGG)');
    return;
  }
  state.songName = file.name.replace(/\.[^/.]+$/, '');
  showScreen('analyzing');

  try {
    const arrayBuffer = await file.arrayBuffer();
    const result = await analyzeAudio(arrayBuffer, (progress, detail) => {
      els.analyzeProgress.style.width = (progress * 100) + '%';
      els.analyzeDetail.textContent = detail;
    });

    state.beatmap     = result.beatmap.map(n => ({ ...n, hit: false, missed: false }));
    state.bpm         = result.bpm;
    state.songDuration = result.duration;
    state.audioBuffer = result.songBuffer;
    state.totalNotes  = state.beatmap.length;

    startGame();
  } catch (err) {
    console.error('Ошибка анализа:', err);
    showScreen('welcome');
    alert('Не удалось проанализировать файл: ' + err.message);
  }
}

// ── AUDIO PLAYBACK ────────────────────────────────────────────
function startAudio(offsetSec = 0) {
  stopAudio();
  state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = state.audioCtx.createBufferSource();
  source.buffer = state.audioBuffer;
  source.connect(state.audioCtx.destination);
  source.start(0, offsetSec);
  state.audioSource = source;
  source.onended = () => {
    if (state.phase === 'playing') endGame();
  };
}

function stopAudio() {
  if (state.audioSource) {
    try { state.audioSource.stop(); } catch(_) {}
    state.audioSource = null;
  }
  if (state.audioCtx) {
    state.audioCtx.close();
    state.audioCtx = null;
  }
}

// ── GAME START / RESTART ──────────────────────────────────────
function startGame(resumeFrom = 0) {
  state.phase = 'playing';
  state.score = 0;
  state.combo = 0;
  state.maxCombo = 0;
  state.hits = { perfect: 0, good: 0, miss: 0 };
  state.notes = [];
  state.judgements = [];
  state.flashes = [];
  state.keyState = {};
  state.pauseOffset = 0;
  state.currentTime = resumeFrom;

  // Сбросить состояние нот
  state.beatmap.forEach(n => { n.hit = false; n.missed = false; });

  // Очередь нот для добавления на экран
  state.noteQueue = [...state.beatmap];

  state.startTimestamp = performance.now() - resumeFrom * 1000;
  startAudio(resumeFrom);

  els.hudSong.textContent = state.songName;
  showScreen('game');
}

function restartGame() {
  stopAudio();
  startGame(0);
}

function pauseGame() {
  if (state.phase !== 'playing') return;
  state.phase = 'paused';
  state.pauseStart = performance.now();
  stopAudio();
  showScreen('pause');
}

function resumeGame() {
  if (state.phase !== 'paused') return;
  const elapsed = performance.now() - state.pauseStart;
  state.startTimestamp += elapsed;
  state.phase = 'playing';
  const t = state.currentTime;
  startAudio(t);
  showScreen('game');
}

function endGame() {
  state.phase = 'results';
  stopAudio();
  showResults();

  // Если результат попадает в топ-10 — спросить имя
  if (state.score > 0 && isHighScore(state.score)) {
    showNameEntry();
  } else {
    showScreen('results');
  }
}

function calcAccuracy() {
  const total = state.totalNotes;
  if (total === 0) return 100;
  return ((state.hits.perfect * 100 + state.hits.good * 50) / (total * 100)) * 100;
}

function calcRank(accuracy) {
  if (accuracy >= 98) return 'SS';
  if (accuracy >= 95) return 'S';
  if (accuracy >= 90) return 'A';
  if (accuracy >= 80) return 'B';
  if (accuracy >= 70) return 'C';
  return 'D';
}

function showResults() {
  const accuracy = calcAccuracy();
  const rank = calcRank(accuracy);
  state._lastRank = rank;
  state._lastAccuracy = accuracy;

  els.resultsRank.textContent = rank;
  els.resScore.textContent = state.score.toLocaleString();
  els.resAccuracy.textContent = accuracy.toFixed(1) + '%';
  els.resCombo.textContent = state.maxCombo;
  els.resPerfect.textContent = state.hits.perfect;
  els.resGood.textContent = state.hits.good;
  els.resMiss.textContent = state.hits.miss;

  // Rank reveal sound (delayed slightly)
  setTimeout(() => soundRankReveal(rank), 200);
}

// ── NAME ENTRY ────────────────────────────────────────────────
function showNameEntry() {
  const accuracy = state._lastAccuracy ?? calcAccuracy();
  const rank = state._lastRank ?? calcRank(accuracy);

  els.nameRank.textContent = rank;
  els.nameScoreVal.textContent = state.score.toLocaleString();

  // Pre-fill placeholder with random name
  const suggested = randomName();
  els.playerNameInput.placeholder = suggested;
  els.playerNameInput.value = '';

  showScreen('name');
}

function saveAndShowLeaderboard() {
  const accuracy = state._lastAccuracy ?? calcAccuracy();
  const rank = state._lastRank ?? calcRank(accuracy);
  const name = els.playerNameInput.value.trim() || els.playerNameInput.placeholder;

  const pos = addScore({
    name,
    score: state.score,
    accuracy: accuracy.toFixed(1),
    rank,
    maxCombo: state.maxCombo,
    songName: state.songName,
  });
  state._lastLeaderboardPos = pos;
  showLeaderboard();
}

// ── LEADERBOARD ───────────────────────────────────────────────
function showLeaderboard(highlightPos = state._lastLeaderboardPos) {
  const scores = getScores();
  const table = els.lbTable;
  table.innerHTML = '';

  if (scores.length === 0) {
    table.innerHTML = '<div class="lb-empty">Пока нет результатов</div>';
    return;
  }

  scores.forEach((entry, i) => {
    const row = document.createElement('div');
    row.className = 'lb-row' + (i === highlightPos ? ' highlight' : '');

    const posClass = i === 0 ? 'lb-pos gold' : i === 1 ? 'lb-pos silver' : i === 2 ? 'lb-pos bronze' : 'lb-pos';
    const medals = ['🥇', '🥈', '🥉'];
    const posLabel = i < 3 ? medals[i] : `#${i + 1}`;

    row.innerHTML = `
      <span class="${posClass}">${posLabel}</span>
      <span class="lb-rank">${entry.rank}</span>
      <span class="lb-name" title="${entry.name}">${entry.name}</span>
      <span class="lb-score">${Number(entry.score).toLocaleString()}</span>
      <span class="lb-date">${entry.date}</span>
    `;
    table.appendChild(row);
  });

  showScreen('leaderboard');
}

// ── INPUT ─────────────────────────────────────────────────────
function setupInput() {
  document.addEventListener('keydown', e => {
    if (e.repeat) return;

    if (e.code === 'Escape') {
      if (state.phase === 'playing') pauseGame();
      else if (state.phase === 'paused') resumeGame();
      return;
    }

    const laneIdx = LANE_KEYS.indexOf(e.code);
    if (laneIdx === -1) return;

    state.keyState[e.code] = true;
    flashLaneKey(laneIdx, true);

    if (state.phase === 'playing') {
      handleHit(laneIdx);
    }
  });

  document.addEventListener('keyup', e => {
    const laneIdx = LANE_KEYS.indexOf(e.code);
    if (laneIdx === -1) return;
    state.keyState[e.code] = false;
    flashLaneKey(laneIdx, false);
  });
}

function flashLaneKey(laneIdx, active) {
  els.keyInds[laneIdx]?.classList.toggle('active', active);
}

function handleHit(laneIdx) {
  const now = state.currentTime;
  let closest = null;
  let closestDist = Infinity;

  for (const note of state.beatmap) {
    if (note.lane !== laneIdx || note.hit || note.missed) continue;
    const dist = Math.abs(note.time - now);
    if (dist < closestDist && dist < HIT_WINDOW_MISS) {
      closestDist = dist;
      closest = note;
    }
  }

  if (!closest) {
    spawnJudgement(laneIdx, 'MISS', '#ef4444');
    soundMiss();
    breakCombo();
    return;
  }

  // Capture note y-position before marking as hit (for flash origin)
  // state.notes has .y; state.beatmap entries don't — look it up
  const liveNote = state.notes.find(n => n.time === closest.time && n.lane === closest.lane);
  const noteY = liveNote?.y ?? state.hitZoneY;
  closest.hit = true;
  const dist = Math.abs(closest.time - now);

  if (dist <= HIT_WINDOW_PERFECT) {
    spawnFlash(laneIdx, noteY, 'perfect');
    registerHit('perfect', laneIdx, closest);
  } else if (dist <= HIT_WINDOW_GOOD) {
    spawnFlash(laneIdx, noteY, 'good');
    registerHit('good', laneIdx, closest);
  } else {
    spawnFlash(laneIdx, noteY, 'good');
    registerHit('good', laneIdx, closest); // near miss → good
  }
}

function registerHit(type, laneIdx, note) {
  state.hits[type]++;
  const scoreAdd = type === 'perfect' ? SCORE_PERFECT : SCORE_GOOD;

  state.combo++;
  if (state.combo > state.maxCombo) state.maxCombo = state.combo;

  // Combo multiplier
  const mult = comboMultiplier(state.combo);
  state.score += Math.round(scoreAdd * mult);

  const color = type === 'perfect' ? '#a855f7' : '#22c55e';
  const label = type === 'perfect' ? 'PERFECT' : 'GOOD';
  spawnJudgement(laneIdx, label, color);
  if (type === 'perfect') soundPerfect(); else soundGood();

  // Combo text in HUD
  els.hudCombo.textContent = state.combo >= 4 ? state.combo + 'x' : '';
  animatePop(els.hudCombo);
}

function breakCombo() {
  state.hits.miss++;
  state.combo = 0;
  els.hudCombo.textContent = '';
}

function comboMultiplier(combo) {
  if (combo >= 100) return 2.0;
  if (combo >= 50)  return 1.5;
  if (combo >= 20)  return 1.2;
  if (combo >= 10)  return 1.1;
  return 1.0;
}

function animatePop(el) {
  el.style.transform = 'scale(1.4)';
  setTimeout(() => { el.style.transform = ''; }, 120);
}

// ── JUDGEMENT FLOATS ──────────────────────────────────────────
function spawnJudgement(laneIdx, text, color) {
  const x = state.laneStartX + laneIdx * state.laneWidth + state.laneWidth / 2;
  const y = state.hitZoneY - 40;
  state.judgements.push({ text, color, x, y, born: performance.now(), isHit: text !== 'MISS' });
}

// ── NOTE HIT FLASH ────────────────────────────────────────────
function spawnFlash(laneIdx, noteY, type) {
  const cx = state.laneStartX + laneIdx * state.laneWidth + state.laneWidth / 2;
  const cy = noteY;
  const isPerfect = type === 'perfect';
  const color = isPerfect ? '#a855f7' : '#22c55e';
  const numParticles = isPerfect ? 12 : 7;
  const particles = [];
  for (let i = 0; i < numParticles; i++) {
    const angle = (i / numParticles) * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
    const speed = isPerfect
      ? 80 + Math.random() * 80
      : 50 + Math.random() * 50;
    particles.push({
      x: cx, y: cy,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      r: isPerfect ? 3 + Math.random() * 3 : 2 + Math.random() * 2,
    });
  }
  state.flashes.push({
    cx, cy,
    color,
    isPerfect,
    born: performance.now(),
    dur: isPerfect ? 420 : 280,
    particles,
  });
}

// ── NOTE QUEUE & SPAWNING ─────────────────────────────────────
const LEAD_TIME = 1.8; // секунды до попадания на hit zone

function spawnDueNotes() {
  if (!state.noteQueue) return;
  while (state.noteQueue.length > 0) {
    const next = state.noteQueue[0];
    if (next.time - state.currentTime <= LEAD_TIME) {
      state.notes.push({
        ...next,
        y: -NOTE_H * 2,
      });
      state.noteQueue.shift();
    } else {
      break;
    }
  }
}

function updateNotes(dt) {
  const hitZoneY = state.hitZoneY;
  const now = state.currentTime;

  for (const note of state.notes) {
    // Позиция ноты: пропорционально времени до попадания
    const timeUntilHit = note.time - now;
    note.y = hitZoneY - timeUntilHit * state.scrollSpeed;
  }

  // Авто-miss: нота прошла hit zone и не была нажата
  for (const note of state.beatmap) {
    if (!note.hit && !note.missed) {
      const timePassed = now - note.time;
      if (timePassed > HIT_WINDOW_MISS) {
        note.missed = true;
        state.hits.miss++;
        breakCombo();
      }
    }
  }

  // Убираем ноты, ушедшие вниз
  const maxY = canvas.height + NOTE_H * 4;
  state.notes = state.notes.filter(n => n.y < maxY && !n.hit);
}

// ── RENDER ────────────────────────────────────────────────────
function render(alpha) {
  if (state.phase !== 'playing' && state.phase !== 'paused') return;

  const W = canvas.width;
  const H = canvas.height;
  const laneW = state.laneWidth;
  const laneX0 = state.laneStartX;
  const hitY = state.hitZoneY;

  // Background
  ctx.fillStyle = '#09090f';
  ctx.fillRect(0, 0, W, H);

  // Side ambient glow (reacts to combo)
  const comboGlow = Math.min(state.combo / 50, 1);
  if (comboGlow > 0) {
    const leftGrad = ctx.createLinearGradient(0, 0, laneX0, 0);
    leftGrad.addColorStop(0, 'rgba(0,0,0,0)');
    leftGrad.addColorStop(1, `rgba(168,85,247,${comboGlow * 0.12})`);
    ctx.fillStyle = leftGrad;
    ctx.fillRect(0, 0, laneX0, H);

    const rightStart = laneX0 + LANE_COUNT * laneW;
    const rightGrad = ctx.createLinearGradient(rightStart, 0, W, 0);
    rightGrad.addColorStop(0, `rgba(168,85,247,${comboGlow * 0.12})`);
    rightGrad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = rightGrad;
    ctx.fillRect(rightStart, 0, W - rightStart, H);
  }

  // Lane background gradient + grid
  for (let i = 0; i < LANE_COUNT; i++) {
    const x = laneX0 + i * laneW;
    const color = LANE_COLORS[i];

    // Lane bg
    const grad = ctx.createLinearGradient(x, 0, x + laneW, 0);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(0.3, hexToRgba(color, 0.04));
    grad.addColorStop(0.7, hexToRgba(color, 0.04));
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(x, 0, laneW, H);

    // Lane border
    ctx.strokeStyle = hexToRgba(color, 0.15);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
  }
  // Right border
  ctx.strokeStyle = hexToRgba(LANE_COLORS[3], 0.15);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(laneX0 + LANE_COUNT * laneW, 0);
  ctx.lineTo(laneX0 + LANE_COUNT * laneW, H);
  ctx.stroke();

  // Beat grid lines (subtle)
  const beatPeriod = 60 / state.bpm; // s per beat
  const now = state.currentTime;
  const numGridLines = Math.ceil(LEAD_TIME / beatPeriod) + 2;
  const firstBeat = Math.ceil(now / beatPeriod) * beatPeriod;
  for (let i = 0; i < numGridLines; i++) {
    const beatTime = firstBeat + i * beatPeriod;
    const timeUntil = beatTime - now;
    const y = hitY - timeUntil * state.scrollSpeed;
    if (y < 0 || y > H) continue;
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(laneX0, y);
    ctx.lineTo(laneX0 + LANE_COUNT * laneW, y);
    ctx.stroke();
  }

  // Hit zone line
  const totalW = LANE_COUNT * laneW;
  const hitGrad = ctx.createLinearGradient(laneX0, 0, laneX0 + totalW, 0);
  LANE_COLORS.forEach((c, i) => {
    hitGrad.addColorStop(i / LANE_COUNT, hexToRgba(c, 0.7));
    hitGrad.addColorStop((i + 1) / LANE_COUNT, hexToRgba(c, 0.7));
  });
  ctx.strokeStyle = hitGrad;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(laneX0, hitY);
  ctx.lineTo(laneX0 + totalW, hitY);
  ctx.stroke();

  // Hit zone glow + mobile tap buttons
  const isMobile = W <= 600;
  for (let i = 0; i < LANE_COUNT; i++) {
    const x = laneX0 + i * laneW + laneW / 2;
    const lx = laneX0 + i * laneW;
    const isPressed = isLanePressed(i);
    const color = LANE_COLORS[i];

    // Mobile: draw tap button area below hit zone
    if (isMobile) {
      const btnTop = hitY + 12;
      const btnH = H - btnTop;
      // Background panel
      ctx.fillStyle = hexToRgba(color, isPressed ? 0.22 : 0.07);
      ctx.fillRect(lx, btnTop, laneW, btnH);
      // Top border accent
      ctx.fillStyle = hexToRgba(color, isPressed ? 0.9 : 0.35);
      ctx.fillRect(lx, btnTop, laneW, 3);
    }

    if (isPressed) {
      const rg = ctx.createRadialGradient(x, hitY, 0, x, hitY, laneW * 0.8);
      rg.addColorStop(0, hexToRgba(color, 0.45));
      rg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = rg;
      ctx.beginPath();
      ctx.ellipse(x, hitY, laneW * 0.8, 30, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ── Flash particles (note hit burst) ──────────────────────────
  {
    const nowMs2 = performance.now();
    for (const fl of state.flashes) {
      const age = nowMs2 - fl.born;
      if (age > fl.dur) continue;
      const t = age / fl.dur;           // 0→1
      const easeOut = 1 - t * t;        // quad ease-out

      // ① Note body squeeze-out: scale from 1→0, fade out
      {
        const scaleX = NOTE_W * (1 - t) * 1.3;
        const scaleY = NOTE_H * (1 - t * 0.8) * 1.2;
        const alpha = easeOut;
        const x = fl.cx - scaleX / 2;
        const y = fl.cy - scaleY / 2;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.shadowColor = fl.color;
        ctx.shadowBlur = fl.isPerfect ? 18 : 8;
        ctx.fillStyle = fl.color;
        if (scaleX > 1 && scaleY > 1) {
          roundRect(ctx, x, y, scaleX, scaleY, Math.min(NOTE_RADIUS, scaleY / 2));
          ctx.fill();
        }
        ctx.restore();
      }

      // ② Expanding glow ring
      {
        const maxR = fl.isPerfect ? 55 : 35;
        const r = t * maxR;
        const alpha = easeOut * (fl.isPerfect ? 0.75 : 0.45);
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = fl.color;
        ctx.lineWidth = fl.isPerfect ? 3 : 2;
        ctx.shadowColor = fl.color;
        ctx.shadowBlur = fl.isPerfect ? 12 : 6;
        ctx.beginPath();
        ctx.arc(fl.cx, fl.cy, r, 0, Math.PI * 2);
        ctx.stroke();
        // Second ring for perfect (slightly delayed)
        if (fl.isPerfect && t > 0.15) {
          const t2 = (t - 0.15) / 0.85;
          const r2 = t2 * maxR * 0.65;
          ctx.globalAlpha = (1 - t2) * (1 - t2) * 0.5;
          ctx.beginPath();
          ctx.arc(fl.cx, fl.cy, r2, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.restore();
      }

      // ③ Particle burst
      {
        for (const p of fl.particles) {
          const px = p.x + p.vx * t;
          const py = p.y + p.vy * t + 60 * t * t; // slight gravity
          const pr = p.r * easeOut;
          const alpha = easeOut * (fl.isPerfect ? 0.9 : 0.65);
          if (pr < 0.3) continue;
          ctx.save();
          ctx.globalAlpha = alpha;
          ctx.fillStyle = fl.isPerfect
            ? (t < 0.4 ? '#ffffff' : fl.color)  // white core → color
            : fl.color;
          ctx.shadowColor = fl.color;
          ctx.shadowBlur = fl.isPerfect ? 8 : 4;
          ctx.beginPath();
          ctx.arc(px, py, pr, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      }
    }
    ctx.shadowBlur = 0;
    // trim expired
    state.flashes = state.flashes.filter(fl => nowMs2 - fl.born < fl.dur);
  }

  // Notes
  for (const note of state.notes) {
    if (note.hit) continue;
    const x = laneX0 + note.lane * laneW + (laneW - NOTE_W) / 2;
    const y = note.y;
    const color = LANE_COLORS[note.lane];

    // Shadow/glow
    ctx.shadowColor = color;
    ctx.shadowBlur = 12;
    // Note body
    ctx.fillStyle = color;
    roundRect(ctx, x, y - NOTE_H / 2, NOTE_W, NOTE_H, NOTE_RADIUS);
    ctx.fill();
    // Inner highlight
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    roundRect(ctx, x + 3, y - NOTE_H / 2 + 3, NOTE_W - 6, 4, 2);
    ctx.fill();
  }
  ctx.shadowBlur = 0;

  // Judgement floats (drawn as canvas text)
  const nowMs = performance.now();
  const FLOAT_DUR = 700;
  for (const j of state.judgements) {
    const age = nowMs - j.born;
    if (age > FLOAT_DUR) continue;
    const t = age / FLOAT_DUR;
    const alpha = 1 - t;
    const dy = t * 50;

    // Hit explosion ring (only for perfect/good)
    if (j.isHit && age < 250) {
      const et = age / 250;
      const radius = et * 60;
      ctx.save();
      ctx.globalAlpha = (1 - et) * 0.6;
      ctx.strokeStyle = j.color;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(j.x, hitY, radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = `900 18px 'Orbitron', 'Courier New', sans-serif`;
    ctx.fillStyle = j.color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = j.color;
    ctx.shadowBlur = 8;
    ctx.fillText(j.text, j.x, j.y - dy);
    ctx.restore();
  }

  // Trim old judgements
  state.judgements = state.judgements.filter(j => nowMs - j.born < FLOAT_DUR);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ── GAME LOOP ─────────────────────────────────────────────────
let rafId = null;
let lastTimestamp = null;

function gameLoop(timestamp) {
  rafId = requestAnimationFrame(gameLoop);

  const dt = lastTimestamp ? Math.min((timestamp - lastTimestamp) / 1000, 0.1) : 0;
  lastTimestamp = timestamp;

  // FPS counter
  state.frameCount++;
  state.fpsAccum += dt;
  if (state.fpsAccum >= 1.0) {
    state.lastFps = Math.round(state.frameCount / state.fpsAccum);
    state.frameCount = 0;
    state.fpsAccum = 0;
  }

  if (state.phase === 'playing') {
    state.currentTime = (timestamp - state.startTimestamp) / 1000;

    // Check song end
    if (state.currentTime >= state.songDuration + 2.0) {
      endGame();
      return;
    }

    spawnDueNotes();
    updateNotes(dt);
    updateHUD();
  }

  render(0);
  updateDebugOverlay();
}

function updateHUD() {
  els.hudScore.textContent = state.score.toLocaleString();

  const total = state.totalNotes;
  const hitsTotal = state.hits.perfect + state.hits.good;
  const accuracy = total > 0
    ? ((state.hits.perfect * 100 + state.hits.good * 50) / (total * 100)) * 100
    : 100;
  els.hudAccuracy.textContent = accuracy.toFixed(1) + '%';

  const progress = Math.min(state.currentTime / state.songDuration, 1);
  els.hudProgress.style.width = (progress * 100) + '%';
}

function updateDebugOverlay() {
  els.debugOverlay.textContent =
    `FPS: ${state.lastFps}  Notes: ${state.notes.length}  Beatmap: ${state.beatmap.length}  BPM: ${state.bpm}`;
}

// ── DETERMINISTIC HOOKS (for testing) ────────────────────────
window.advanceTime = (ms) => {
  const steps = Math.max(1, Math.round(ms / (1000 / 60)));
  for (let i = 0; i < steps; i++) {
    if (state.phase === 'playing') {
      state.currentTime += 1 / 60;
      spawnDueNotes();
      updateNotes(1 / 60);
    }
  }
  render(0);
};

window.render_game_to_text = () => JSON.stringify({
  phase: state.phase,
  currentTime: state.currentTime,
  score: state.score,
  combo: state.combo,
  maxCombo: state.maxCombo,
  hits: state.hits,
  totalNotes: state.totalNotes,
  notesOnScreen: state.notes.length,
  bpm: state.bpm,
});

// ── UI BINDINGS ───────────────────────────────────────────────
function setupUI() {
  // Game controls
  els.pauseBtn.addEventListener('click', pauseGame);
  els.btnResume.addEventListener('click', resumeGame);
  els.btnRestart.addEventListener('click', restartGame);
  els.btnMenuFromPause.addEventListener('click', () => {
    stopAudio(); state.phase = 'menu'; showScreen('welcome');
  });

  // Results
  els.btnRetry.addEventListener('click', restartGame);
  els.btnLeaderboard?.addEventListener('click', () => {
    state._lastLeaderboardPos = undefined;
    showLeaderboard();
  });
  els.btnMenu.addEventListener('click', () => {
    stopAudio(); state.phase = 'menu'; showScreen('welcome');
  });

  // Name entry
  els.nameDiceBtn?.addEventListener('click', () => {
    soundMenuClick();
    els.playerNameInput.placeholder = randomName();
    els.playerNameInput.value = '';
    els.playerNameInput.focus();
  });
  els.btnSaveScore?.addEventListener('click', () => {
    soundMenuClick();
    saveAndShowLeaderboard();
  });
  els.btnSkipScore?.addEventListener('click', () => {
    showScreen('results');
  });
  // Enter key in name input
  els.playerNameInput?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { soundMenuClick(); saveAndShowLeaderboard(); }
  });

  // Leaderboard
  els.lbClearBtn?.addEventListener('click', () => {
    if (confirm('Очистить все результаты?')) {
      import('./leaderboard.js').then(m => { m.clearScores(); showLeaderboard(); });
    }
  });
  els.lbRetryBtn?.addEventListener('click', restartGame);
  els.lbMenuBtn?.addEventListener('click', () => {
    state.phase = 'menu'; showScreen('welcome');
  });

  // Welcome leaderboard button
  els.lbWelcomeBtn?.addEventListener('click', () => {
    soundMenuClick();
    state._lastLeaderboardPos = undefined;
    showLeaderboard();
  });
}

// ── DEVICE DETECTION ────────────────────────────────────────────
const isTouchDevice = () => ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);

// ── AUDIO CONTEXT UNLOCK (Android/iOS require user gesture) ─────
let audioCtxUnlocked = false;
function unlockAudioContext() {
  if (audioCtxUnlocked) return;
  try {
    const tmpCtx = new (window.AudioContext || window.webkitAudioContext)();
    const buf = tmpCtx.createBuffer(1, 1, 22050);
    const src = tmpCtx.createBufferSource();
    src.buffer = buf;
    src.connect(tmpCtx.destination);
    src.start(0);
    tmpCtx.resume().then(() => { tmpCtx.close(); });
    audioCtxUnlocked = true;
    unlockSfxCtx(); // also unlock the sound engine context
  } catch (_) {}
}

// ── TOUCH ZONES ─────────────────────────────────────────────────
const touchZonesEl = document.getElementById('touch-zones');
const touchZoneEls = document.querySelectorAll('.touch-zone');

// activeTouches: Map<touchId, laneIdx>
const activeTouches = new Map();

function posToLane(clientX) {
  const x = clientX - state.laneStartX;
  const lane = Math.floor(x / state.laneWidth);
  if (lane < 0 || lane >= LANE_COUNT) return -1;
  return lane;
}

function setupTouchZones() {
  if (!isTouchDevice()) return;

  // Show mobile UI elements
  document.getElementById('mobile-pick-btn').style.display = 'flex';
  document.getElementById('controls-hint').style.display = 'none';
  document.getElementById('controls-hint-mobile').style.display = 'flex';
  document.getElementById('drop-zone').style.display = 'none';

  // Mobile subtitle
  const sub = document.getElementById('welcome-subtitle');
  if (sub) sub.textContent = 'Нажми кнопку, выбери MP3 — игра сгенерирует beatmap';

  // Touch zones: pointer-events on
  touchZonesEl.style.pointerEvents = 'auto';

  // Layout touch zones to match canvas lanes
  function layoutTouchZones() {
    touchZonesEl.style.left   = state.laneStartX + 'px';
    touchZonesEl.style.width  = (state.laneWidth * LANE_COUNT) + 'px';
    const tapH = Math.round(canvas.height * 0.45);
    touchZonesEl.style.height = tapH + 'px';
    touchZoneEls.forEach(el => { el.style.height = tapH + 'px'; });
  }
  layoutTouchZones();
  window.addEventListener('resize', layoutTouchZones);

  // touchstart on canvas-covering zones
  touchZonesEl.addEventListener('touchstart', e => {
    e.preventDefault();
    unlockAudioContext();
    for (const t of e.changedTouches) {
      const lane = posToLane(t.clientX);
      if (lane === -1) continue;
      activeTouches.set(t.identifier, lane);
      flashLaneKey(lane, true);
      touchZoneEls[lane]?.classList.add('active');
      if (state.phase === 'playing') handleHit(lane);
      state.keyState['touch_' + lane] = true;
    }
  }, { passive: false });

  touchZonesEl.addEventListener('touchend', e => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      const lane = activeTouches.get(t.identifier);
      if (lane === undefined) continue;
      activeTouches.delete(t.identifier);
      flashLaneKey(lane, false);
      touchZoneEls[lane]?.classList.remove('active');
      state.keyState['touch_' + lane] = false;
    }
  }, { passive: false });

  touchZonesEl.addEventListener('touchcancel', e => {
    for (const t of e.changedTouches) {
      const lane = activeTouches.get(t.identifier);
      if (lane === undefined) continue;
      activeTouches.delete(t.identifier);
      flashLaneKey(lane, false);
      touchZoneEls[lane]?.classList.remove('active');
      state.keyState['touch_' + lane] = false;
    }
  }, { passive: false });

  // Unlock AudioContext on welcome screen tap
  document.getElementById('screen-welcome').addEventListener('touchstart', unlockAudioContext, { once: true, passive: true });
}

// Patch isLanePressed to include touch state
function isLanePressed(i) {
  return state.keyState[LANE_KEYS[i]] || state.keyState['touch_' + i];
}

// ── MOBILE FILE PICKER ───────────────────────────────────────────
function setupMobilePicker() {
  const btn = document.getElementById('mobile-pick-btn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    unlockAudioContext();
    els.fileInput.click();
  });
}

// ── INIT ──────────────────────────────────────────────────────
// ── DEFAULT TRACK ───────────────────────────────────────────────
async function loadDefaultTrack() {
  const btn = document.getElementById('btn-default-track');
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = 'Загрузка...';
  try {
    const resp = await fetch('./default-track.mp3');
    if (!resp.ok) throw new Error('fetch failed');
    const arrayBuffer = await resp.arrayBuffer();
    const blob = new Blob([arrayBuffer], { type: 'audio/mp3' });
    const file = new File([blob], 'Vivaldi - Four Seasons Summer.mp3', { type: 'audio/mp3' });
    btn.disabled = false;
    btn.textContent = '▶ Vivaldi — Summer';
    btn.onclick = () => { unlockAudioContext(); loadFile(file); };
  } catch (err) {
    console.warn('Default track load failed:', err);
    btn.style.display = 'none';
  }
}

function init() {
  showScreen('welcome');
  setupDropZone();
  setupInput();
  setupUI();
  setupTouchZones();
  setupMobilePicker();
  loadDefaultTrack();

  // Unlock audio on first user interaction (desktop)
  document.addEventListener('click', () => { unlockSfxCtx(); }, { once: true, passive: true });
  document.addEventListener('keydown', () => { unlockSfxCtx(); }, { once: true, passive: true });

  requestAnimationFrame(gameLoop);
}

init();
