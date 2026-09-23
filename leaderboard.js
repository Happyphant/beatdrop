/**
 * BeatDrop — Leaderboard
 * Топ-10 результатов в localStorage
 */

const LS_KEY = 'beatdrop_scores_v1';
const MAX_ENTRIES = 10;

// Случайные имена (adjective + noun)
const ADJECTIVES = [
  'Cosmic', 'Neon', 'Pixel', 'Turbo', 'Silent', 'Ghost', 'Hyper', 'Sonic',
  'Atomic', 'Lunar', 'Cyber', 'Vortex', 'Ultra', 'Blaze', 'Frost', 'Void',
  'Storm', 'Nova', 'Pulse', 'Drift',
];
const NOUNS = [
  'Rabbit', 'Tiger', 'Phoenix', 'Dragon', 'Falcon', 'Ninja', 'Panda', 'Wolf',
  'Rider', 'Comet', 'Samurai', 'Raven', 'Serpent', 'Hawk', 'Lynx', 'Hydra',
  'Viper', 'Wraith', 'Specter', 'Blade',
];

export function randomName() {
  const adj  = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const num  = Math.floor(Math.random() * 99) + 1;
  return `${adj}${noun}${num}`;
}

// ── CRUD ─────────────────────────────────────────────────────

export function getScores() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveScores(scores) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(scores));
  } catch (_) {}
}

/**
 * Добавить результат.
 * @returns {number} position (0-based) в топ, или -1 если не вошёл
 */
export function addScore({ name, score, accuracy, rank, maxCombo, songName }) {
  const scores = getScores();
  const entry = {
    name: (name || '').trim() || randomName(),
    score,
    accuracy,
    rank,
    maxCombo,
    songName,
    date: new Date().toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' }),
  };
  scores.push(entry);
  scores.sort((a, b) => b.score - a.score);
  const trimmed = scores.slice(0, MAX_ENTRIES);
  saveScores(trimmed);
  const pos = trimmed.findIndex(e => e === entry);
  return pos; // -1 if entry was cut
}

export function isHighScore(score) {
  const scores = getScores();
  if (scores.length < MAX_ENTRIES) return true;
  return score > scores[scores.length - 1].score;
}

export function clearScores() {
  localStorage.removeItem(LS_KEY);
}
