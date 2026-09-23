/**
 * Audio Analyzer — анализирует MP3 через OfflineAudioContext
 * Возвращает beatmap: массив { time, lane } + BPM
 */

export async function analyzeAudio(arrayBuffer, onProgress) {
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  // Декодируем аудио
  onProgress(0.05, 'Декодирование аудио...');
  const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  onProgress(0.20, 'Анализ частот...');

  const sampleRate = audioBuffer.sampleRate;
  const duration = audioBuffer.duration;
  const channelData = audioBuffer.getChannelData(0); // моно

  // ── 1. Onset detection (пики энергии) ──────────────
  // Делим сигнал на короткие фреймы, считаем энергию, ищем пики
  const frameSize = Math.round(sampleRate * 0.023); // ~23ms frames
  const hopSize = Math.round(sampleRate * 0.010);   // ~10ms hop
  const numFrames = Math.floor((channelData.length - frameSize) / hopSize);

  // Спектральный поток энергии
  const energy = new Float32Array(numFrames);
  for (let i = 0; i < numFrames; i++) {
    let sum = 0;
    const start = i * hopSize;
    for (let j = 0; j < frameSize; j++) {
      const s = channelData[start + j] || 0;
      sum += s * s;
    }
    energy[i] = sum / frameSize;
  }

  onProgress(0.40, 'Поиск ударов...');

  // Детектируем пики: локальный максимум, выше среднего * threshold
  const windowLen = Math.round(0.1 / 0.010); // 100ms окно для среднего
  const onsets = [];

  for (let i = windowLen; i < numFrames - windowLen; i++) {
    const frame = energy[i];
    // Локальный максимум
    let isMax = true;
    for (let k = i - 3; k <= i + 3; k++) {
      if (k !== i && energy[k] >= frame) { isMax = false; break; }
    }
    if (!isMax) continue;

    // Выше адаптивного порога
    let localSum = 0;
    for (let k = i - windowLen; k < i; k++) localSum += energy[k];
    const localMean = localSum / windowLen;
    const threshold = localMean * 1.8 + 0.00005;

    if (frame > threshold) {
      onsets.push(i * hopSize / sampleRate);
    }
  }

  onProgress(0.60, 'Определение BPM...');

  // ── 2. BPM estimation (inter-onset intervals) ──────
  const bpm = estimateBPM(onsets, duration);

  onProgress(0.75, 'Генерация beatmap...');

  // ── 3. Beatmap generation ──────────────────────────
  const beatmap = generateBeatmap(onsets, bpm, duration);

  onProgress(1.0, 'Готово!');
  audioCtx.close();

  return { beatmap, bpm, duration, songBuffer: audioBuffer };
}

function estimateBPM(onsets, duration) {
  if (onsets.length < 4) return 120;

  // IOI histogram
  const iois = [];
  for (let i = 1; i < onsets.length; i++) {
    const d = onsets[i] - onsets[i - 1];
    if (d > 0.1 && d < 2.0) iois.push(d);
  }
  if (!iois.length) return 120;

  // Bins от 0.25s (240bpm) до 1.0s (60bpm), шаг 10ms
  const binSize = 0.01;
  const minIOI = 0.25, maxIOI = 1.0;
  const bins = new Float32Array(Math.ceil((maxIOI - minIOI) / binSize));
  for (const ioi of iois) {
    if (ioi < minIOI || ioi > maxIOI) continue;
    // Также включаем кратные (деление)
    for (const div of [1, 2, 4]) {
      const v = ioi / div;
      if (v >= minIOI && v <= maxIOI) {
        const idx = Math.floor((v - minIOI) / binSize);
        if (idx < bins.length) bins[idx]++;
      }
    }
  }

  let maxBin = 0, maxIdx = 0;
  for (let i = 0; i < bins.length; i++) {
    if (bins[i] > maxBin) { maxBin = bins[i]; maxIdx = i; }
  }

  const beatPeriod = minIOI + maxIdx * binSize + binSize / 2;
  const rawBpm = 60 / beatPeriod;

  // Нормализуем в диапазон 60–180
  let bpm = rawBpm;
  while (bpm < 60) bpm *= 2;
  while (bpm > 180) bpm /= 2;

  return Math.round(bpm);
}

function generateBeatmap(onsets, bpm, duration) {
  if (!onsets.length) return [];

  // Убираем слишком близкие онсеты (< 100ms)
  const filtered = [];
  let lastTime = -1;
  for (const t of onsets) {
    if (t - lastTime >= 0.10) {
      filtered.push(t);
      lastTime = t;
    }
  }

  // Ограничиваем плотность: не более ~8 нот в секунду
  const maxNotesPerSec = 7;
  const sparse = [];
  let windowStart = 0;
  let windowCount = 0;
  for (const t of filtered) {
    // Удаляем из окна то, что вышло за 1 секунду
    while (sparse.length > 0 && t - sparse[sparse.length - Math.min(sparse.length, 7)].time > 1.0) {
      windowCount = 0;
      // пересчёт
      for (const n of sparse) {
        if (t - n.time < 1.0) windowCount++;
      }
      break;
    }
    windowCount = sparse.filter(n => t - n.time < 1.0).length;
    if (windowCount < maxNotesPerSec) {
      sparse.push({ time: t });
    }
  }

  // Назначаем дорожки (0–3): стараемся чередовать, + немного рандомизируем
  const LANES = 4;
  let laneHistory = [];
  const beatmap = [];

  for (const note of sparse) {
    // Выбираем lane, избегая двух одинаковых подряд
    let lane;
    const lastLane = laneHistory[laneHistory.length - 1];
    const secondLast = laneHistory[laneHistory.length - 2];
    let attempts = 0;
    do {
      lane = Math.floor(Math.random() * LANES);
      attempts++;
    } while (attempts < 6 && (lane === lastLane || lane === secondLast));

    laneHistory.push(lane);
    if (laneHistory.length > 4) laneHistory.shift();

    beatmap.push({ time: note.time, lane });
  }

  return beatmap;
}
