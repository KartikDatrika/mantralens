/*
  Om Reveal
  =========
  Every animation frame reads the microphone and answers three questions:

    1. Is someone chanting?     Loudness above the room's noise floor.
    2. How steady is the tone?  How little the recent pitch has wandered.
    3. Did an Om just end?      Onset and release timing group frames into chants.

  Steady chanting grows the image's clarity. Each good Om also banks a reward
  that is paid out in the silence after it. Clarity only ever grows.

  Two things are drawn from this: the artwork, from clarity (earned slowly),
  and a halo, from live loudness (instant), so the chanter always feels heard.
*/


/* ── Settings ────────────────────────────────────────────────────────────── */

const LISTENING = {
  pitchRangeHz: { min: 65, max: 500 },
  pitchConfidenceMin: 0.6,    // periodicity (0–1) needed to trust a pitch
  pitchHistoryFrames: 20,     // ≈ 0.33 s at 60 fps
  pitchHistoryMinFrames: 8,
  wobbleLimitCents: 40,     // pitch spread at which steadiness reaches 0

  onsetDelayMs: 120,    // voice must last this long to start a chant
  releaseDelayMs: 300,    // silence must last this long to end one

  calibrationMs: 1500,
  noisePercentile: 0.9,
  thresholdOverNoise: 3,
  thresholdMin: 0.006,  // RMS floor, in case calibration was near-silent
};

const REVEAL = {
  clarityPerSteadySecond: 0.045,
  steadinessEmphasis: 1.5,   // > 1 favours very steady tone over merely steady
  silenceRewardPerChant: 0.05,  // scaled by that chant's steadiness
  silenceRewardPerSecond: 0.06,

  chantMinSeconds: 1.5,
  chantMinSteadiness: 0.4,
  feedbackMinSeconds: 0.4,   // shorter sounds are ignored, not critiqued
};

const LOOK = {
  maxBlurPx: 28,
  darkestBrightness: 0.35,
  clarityEasePerSecond: 4,
  haloEasePerSecond: 10,
  haloFloor: 0.15,
  haloFullAtThresholds: 10,    // loudness, in multiples of the voice threshold
  readoutFullAtThresholds: 12,
  phaseGuess: { nasalLowBandRatio: 0.8, openCentroidHz: 1100 },
};


/* ── Page elements ───────────────────────────────────────────────────────── */

const byId = id => document.getElementById(id);

const ui = {
  artwork: byId('artwork'),
  voiceHalo: byId('voice-halo'),
  status: byId('status'),
  clarityFill: byId('clarity-fill'),
  chantFeedback: byId('chant-feedback'),
  startButton: byId('start-button'),
  resetButton: byId('reset-button'),
  imageInput: byId('image-input'),
  readout: {
    panel: byId('readout'),
    levelFill: byId('level-fill'),
    levelThreshold: byId('level-threshold'),
    chanting: byId('readout-chanting'),
    pitch: byId('readout-pitch'),
    steadiness: byId('readout-steadiness'),
    centroid: byId('readout-centroid'),
    lowBand: byId('readout-low-band'),
    phase: byId('readout-phase'),
    noise: byId('readout-noise'),
  },
};


/* ── The session: start, then one pass per frame ─────────────────────────── */

let session = null;

async function startSession() {
  ui.startButton.disabled = true;
  try {
    const microphone = await openMicrophone();
    showStatus('Stay silent for a moment. Measuring the room…');
    const noiseFloor = await measureNoiseFloor(microphone);

    session = {
      microphone,
      noiseFloor,
      voiceThreshold: Math.max(noiseFloor * LISTENING.thresholdOverNoise, LISTENING.thresholdMin),
      steadiness: new SteadinessTracker(),
      chants: new ChantDetector(),
      reveal: new Reveal(),
      displayedClarity: 0,
      haloLevel: 0,
      announcedComplete: false,
      lastFrameAt: performance.now(),
    };

    ui.resetButton.disabled = false;
    showStatus('Chant Om.');
    requestAnimationFrame(onFrame);
  } catch (error) {
    ui.startButton.disabled = false;
    showStatus('Microphone blocked. Allow mic access, and open this page from localhost or https.');
    console.error(error);
  }
}

function onFrame(now) {
  const elapsedSeconds = Math.min(0.1, (now - session.lastFrameAt) / 1000);
  session.lastFrameAt = now;

  const voice = readVoice(session.microphone, session.voiceThreshold);

  if (voice.pitchHz) session.steadiness.add(voice.pitchHz);
  else if (!voice.isVoiced) session.steadiness.clear();
  const frameSteadiness = voice.pitchHz ? session.steadiness.value : 0;

  const endedChant = session.chants.update(voice.isVoiced, frameSteadiness, now, elapsedSeconds);
  if (endedChant) judgeChant(endedChant);

  if (session.chants.isChanting) session.reveal.grow(frameSteadiness, elapsedSeconds);
  else session.reveal.payReward(elapsedSeconds);

  session.displayedClarity = approach(session.displayedClarity, session.reveal.clarity, LOOK.clarityEasePerSecond * elapsedSeconds);
  session.haloLevel = approach(session.haloLevel, haloTarget(voice), LOOK.haloEasePerSecond * elapsedSeconds);

  renderArtwork(session.displayedClarity);
  renderHalo(session.haloLevel);
  renderStatus();
  renderReadout(voice);

  requestAnimationFrame(onFrame);
}

function judgeChant(chant) {
  if (earnsReward(chant)) session.reveal.bankReward(chant.steadiness);
  const feedback = describeChant(chant, session.reveal.rewardedChants);
  if (feedback) ui.chantFeedback.textContent = feedback;
}

function resetReveal() {
  session.reveal = new Reveal();
  session.displayedClarity = 0;
  session.announcedComplete = false;
  ui.chantFeedback.textContent = '';
  showStatus('Chant Om.');
}


/* ── Microphone ──────────────────────────────────────────────────────────── */

async function openMicrophone() {
  // Browser voice processing treats a held tone as noise and flattens loudness.
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  const context = new AudioContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;              // several periods of the lowest pitch we look for
  analyser.smoothingTimeConstant = 0;   // each signal is smoothed where it is used
  context.createMediaStreamSource(stream).connect(analyser);

  const waveform = new Float32Array(analyser.fftSize);
  const spectrumDb = new Float32Array(analyser.frequencyBinCount);

  return {
    sampleRate: context.sampleRate,
    binWidthHz: context.sampleRate / analyser.fftSize,
    readWaveform() { analyser.getFloatTimeDomainData(waveform); return waveform; },
    readSpectrumDb() { analyser.getFloatFrequencyData(spectrumDb); return spectrumDb; },
  };
}

// A high percentile, so ordinary room sounds (a fan, a click) stay below the voice threshold.
function measureNoiseFloor(microphone) {
  return new Promise(resolve => {
    const loudnessSamples = [];
    const startedAt = performance.now();
    (function sample() {
      loudnessSamples.push(rootMeanSquare(microphone.readWaveform()));
      if (performance.now() - startedAt < LISTENING.calibrationMs) return requestAnimationFrame(sample);
      resolve(percentile(loudnessSamples, LISTENING.noisePercentile));
    })();
  });
}

function readVoice(microphone, voiceThreshold) {
  const waveform = microphone.readWaveform();
  const loudness = rootMeanSquare(waveform);
  const isVoiced = loudness > voiceThreshold;
  const pitchHz = isVoiced ? estimatePitchHz(waveform, microphone.sampleRate) : 0;
  return { loudness, isVoiced, pitchHz };
}


/* ── Pitch ───────────────────────────────────────────────────────────────────
   Compare the waveform with delayed copies of itself (McLeod's normalized
   autocorrelation). A delay that lines up well is one period of the voice.
   Returns 0 when no clear period exists.
*/

let periodicityByLag = new Float32Array(0);

function estimatePitchHz(waveform, sampleRate) {
  const shortestLag = Math.floor(sampleRate / LISTENING.pitchRangeHz.max);
  const longestLag = Math.min(Math.floor(sampleRate / LISTENING.pitchRangeHz.min), waveform.length - 2);
  if (periodicityByLag.length < longestLag + 2) periodicityByLag = new Float32Array(longestLag + 2);

  let strongest = 0;
  for (let lag = shortestLag; lag <= longestLag + 1; lag++) {
    periodicityByLag[lag] = periodicityAt(waveform, lag);
    if (lag <= longestLag) strongest = Math.max(strongest, periodicityByLag[lag]);
  }
  if (strongest < LISTENING.pitchConfidenceMin) return 0;

  // The first near-strongest peak, not the strongest: that is often double the period, an octave low.
  const goodEnough = 0.9 * strongest;
  for (let lag = shortestLag + 1; lag <= longestLag; lag++) {
    const before = periodicityByLag[lag - 1], here = periodicityByLag[lag], after = periodicityByLag[lag + 1];
    if (here >= goodEnough && here >= before && here >= after) {
      return sampleRate / (lag + parabolicPeakOffset(before, here, after));
    }
  }
  return 0;
}

// 1 when the waveform repeats exactly after `lag` samples, near 0 when unrelated.
function periodicityAt(waveform, lag) {
  let correlation = 0, energy = 0;
  for (let i = 0; i < waveform.length - lag; i++) {
    const now = waveform[i], later = waveform[i + lag];
    correlation += now * later;
    energy += now * now + later * later;
  }
  return energy > 0 ? 2 * correlation / energy : 0;
}

// Where the true peak sits between samples, from its two neighbours.
function parabolicPeakOffset(before, here, after) {
  const curvature = before - 2 * here + after;
  return curvature !== 0 ? 0.5 * (before - after) / curvature : 0;
}


/* ── Steadiness ──────────────────────────────────────────────────────────────
   How little the pitch has wandered lately: 1 is rock steady, 0 is wandering.
   Measured in cents, because pitch wobble is heard logarithmically.
*/

class SteadinessTracker {
  #recentCents = [];

  add(pitchHz) {
    this.#recentCents.push(1200 * Math.log2(pitchHz));
    if (this.#recentCents.length > LISTENING.pitchHistoryFrames) this.#recentCents.shift();
  }

  clear() { this.#recentCents.length = 0; }

  get value() {
    if (this.#recentCents.length < LISTENING.pitchHistoryMinFrames) return 0;
    return clamp(1 - standardDeviation(this.#recentCents) / LISTENING.wobbleLimitCents, 0, 1);
  }
}


/* ── Chants ──────────────────────────────────────────────────────────────────
   Groups frames into chants. A short blip does not start one;
   a short breath does not end one.
*/

class ChantDetector {
  isChanting = false;
  #voicedMs = 0;
  #silentMs = 0;
  #startedAt = 0;
  #steadinessSamples = [];

  // Returns { seconds, steadiness } on the frame a chant ends, otherwise null.
  update(isVoiced, steadiness, now, elapsedSeconds) {
    const elapsedMs = elapsedSeconds * 1000;

    if (isVoiced) {
      this.#silentMs = 0;
      if (this.isChanting) {
        this.#steadinessSamples.push(steadiness);
      } else {
        this.#voicedMs += elapsedMs;
        if (this.#voicedMs > LISTENING.onsetDelayMs) this.#begin(now);
      }
      return null;
    }

    this.#voicedMs = 0;
    if (!this.isChanting) return null;
    this.#silentMs += elapsedMs;
    return this.#silentMs > LISTENING.releaseDelayMs ? this.#end(now) : null;
  }

  #begin(now) {
    this.isChanting = true;
    this.#startedAt = now;
    this.#steadinessSamples = [];
  }

  #end(now) {
    this.isChanting = false;
    return {
      seconds: (now - this.#startedAt - this.#silentMs) / 1000,
      steadiness: average(this.#steadinessSamples),
    };
  }
}

function earnsReward(chant) {
  return chant.seconds >= REVEAL.chantMinSeconds && chant.steadiness >= REVEAL.chantMinSteadiness;
}

function describeChant(chant, rewardedCount) {
  const seconds = chant.seconds.toFixed(1);
  const steadiness = asPercent(chant.steadiness);
  if (earnsReward(chant)) return `Om ${rewardedCount}: ${seconds} s, steadiness ${steadiness}%`;
  if (chant.seconds < REVEAL.feedbackMinSeconds) return null;
  if (chant.seconds < REVEAL.chantMinSeconds) return `That one was ${seconds} s. Hold it a little longer.`;
  return `Steadiness ${steadiness}%. Try holding one even pitch.`;
}


/* ── Reveal ──────────────────────────────────────────────────────────────────
   The image's clarity, from 0 to 1. Steady chanting grows it directly;
   each good chant banks a reward, paid out in the silence that follows.
*/

class Reveal {
  clarity = 0;
  rewardedChants = 0;
  #bankedReward = 0;

  get isComplete() { return this.clarity >= 1; }

  grow(steadiness, elapsedSeconds) {
    this.#add(steadiness ** REVEAL.steadinessEmphasis * REVEAL.clarityPerSteadySecond * elapsedSeconds);
  }

  bankReward(chantSteadiness) {
    this.rewardedChants++;
    this.#bankedReward += REVEAL.silenceRewardPerChant * chantSteadiness;
  }

  payReward(elapsedSeconds) {
    const payment = Math.min(this.#bankedReward, REVEAL.silenceRewardPerSecond * elapsedSeconds);
    this.#bankedReward -= payment;
    this.#add(payment);
  }

  #add(amount) { this.clarity = Math.min(1, this.clarity + amount); }
}


/* ── Rendering ───────────────────────────────────────────────────────────── */

function renderArtwork(clarity) {
  const haze = 1 - clarity;
  // Blur lifts ahead of colour and light, so the form emerges before it glows.
  const blurPx = LOOK.maxBlurPx * haze ** 1.5;
  const brightness = LOOK.darkestBrightness + (1 - LOOK.darkestBrightness) * clarity;
  ui.artwork.style.filter = `blur(${blurPx.toFixed(2)}px) grayscale(${asPercent(haze)}%) brightness(${brightness.toFixed(3)})`;
  ui.clarityFill.style.width = `${(clarity * 100).toFixed(1)}%`;
}

function haloTarget(voice) {
  if (!voice.isVoiced) return 0;
  return clamp(voice.loudness / (session.voiceThreshold * LOOK.haloFullAtThresholds), LOOK.haloFloor, 1);
}

function renderHalo(level) {
  ui.voiceHalo.style.opacity = level.toFixed(3);
}

function renderStatus() {
  if (session.announcedComplete) return;
  if (session.reveal.isComplete && !session.chants.isChanting) {
    session.announcedComplete = true;
    showStatus('Pūrṇam. The image is fully revealed.');
    return;
  }
  showStatus(session.chants.isChanting ? 'Listening…' : `Clarity ${asPercent(session.displayedClarity)}%. Chant Om.`);
}

function showStatus(text) {
  ui.status.textContent = text;
}

function renderReadout(voice) {
  const r = ui.readout;
  if (!r.panel.open) return;

  const fullScale = session.voiceThreshold * LOOK.readoutFullAtThresholds;
  r.levelFill.style.width = `${clamp(voice.loudness / fullScale, 0, 1) * 100}%`;
  r.levelThreshold.style.left = `${clamp(session.voiceThreshold / fullScale, 0, 1) * 100}%`;
  r.chanting.textContent = session.chants.isChanting ? 'yes' : 'no';
  r.pitch.textContent = voice.pitchHz ? `${voice.pitchHz.toFixed(1)} Hz` : '—';
  r.noise.textContent = `${session.noiseFloor.toFixed(4)} RMS`;

  if (!voice.isVoiced) {
    r.steadiness.textContent = r.centroid.textContent = r.lowBand.textContent = r.phase.textContent = '—';
    return;
  }
  const spectrum = describeSpectrum(session.microphone.readSpectrumDb(), session.microphone.binWidthHz);
  r.steadiness.textContent = `${asPercent(session.steadiness.value)}%`;
  r.centroid.textContent = `${Math.round(spectrum.centroidHz)} Hz`;
  r.lowBand.textContent = spectrum.lowBandRatio.toFixed(2);
  r.phase.textContent = guessPhase(spectrum);
}

// Where the energy sits, and how much of it is low. A nasal M concentrates energy below 500 Hz.
function describeSpectrum(spectrumDb, binWidthHz, upperHz = 4000, lowBandHz = 500) {
  const upperBin = Math.floor(upperHz / binWidthHz);
  const lowBandBin = Math.floor(lowBandHz / binWidthHz);
  let weightedHz = 0, total = 0, lowBand = 0;
  for (let bin = 1; bin < upperBin; bin++) {
    const magnitude = 10 ** (spectrumDb[bin] / 20);
    weightedHz += bin * binWidthHz * magnitude;
    total += magnitude;
    if (bin < lowBandBin) lowBand += magnitude;
  }
  return {
    centroidHz: total ? weightedHz / total : 0,
    lowBandRatio: total ? lowBand / total : 0,
  };
}

function guessPhase({ centroidHz, lowBandRatio }) {
  if (lowBandRatio > LOOK.phaseGuess.nasalLowBandRatio) return 'M (nasal)';
  return centroidHz > LOOK.phaseGuess.openCentroidHz ? 'A (open)' : 'U (rounded)';
}


/* ── Artwork ─────────────────────────────────────────────────────────────── */

const MANDALA_COLOURS = {
  centreGlow: '#ffd97a', saffron: '#e0782a', dusk: '#5a1a2e', edge: '#1a0a12',
  outerPetal: 'rgba(179,38,30,.88)', innerPetal: 'rgba(240,150,60,.92)', petalEdge: 'rgba(255,245,220,.55)',
  disc: '#fff3d6', discEdge: '#c8892c', bead: 'rgba(255,230,170,.8)', syllable: '#7a1f1f',
};

function drawMandala(canvas) {
  const pen = canvas.getContext('2d');
  const size = canvas.width, centre = size / 2, c = MANDALA_COLOURS;

  const background = pen.createRadialGradient(centre, centre, 30, centre, centre, size * 0.72);
  background.addColorStop(0, c.centreGlow);
  background.addColorStop(0.35, c.saffron);
  background.addColorStop(0.75, c.dusk);
  background.addColorStop(1, c.edge);
  pen.fillStyle = background;
  pen.fillRect(0, 0, size, size);

  pen.save();
  pen.translate(centre, centre);
  drawRays(pen, 72, size);
  drawPetalRing(pen, { count: 16, radius: 262, length: 74, width: 30, fill: c.outerPetal });
  drawPetalRing(pen, { count: 8, radius: 182, length: 64, width: 36, fill: c.innerPetal, turn: Math.PI / 8 });
  drawDisc(pen, 124);
  drawBeadRing(pen, { count: 48, radius: 345, beadRadius: 6 });
  drawSyllable(pen, 'ॐ', 160);
  pen.restore();
}

function drawRays(pen, count, length) {
  for (let i = 0; i < count; i++) {
    pen.rotate(Math.PI * 2 / count);
    pen.fillStyle = i % 2 ? 'rgba(255,220,150,.07)' : 'rgba(255,240,200,.13)';
    pen.beginPath();
    pen.moveTo(0, 0); pen.lineTo(-14, -length); pen.lineTo(14, -length);
    pen.closePath();
    pen.fill();
  }
}

function drawPetalRing(pen, { count, radius, length, width, fill, turn = 0 }) {
  for (let i = 0; i < count; i++) {
    pen.save();
    pen.rotate(turn + i * Math.PI * 2 / count);
    pen.beginPath();
    pen.ellipse(0, -radius, width, length, 0, 0, Math.PI * 2);
    pen.fillStyle = fill;
    pen.fill();
    pen.lineWidth = 2;
    pen.strokeStyle = MANDALA_COLOURS.petalEdge;
    pen.stroke();
    pen.restore();
  }
}

function drawDisc(pen, radius) {
  pen.beginPath();
  pen.arc(0, 0, radius, 0, Math.PI * 2);
  pen.fillStyle = MANDALA_COLOURS.disc;
  pen.fill();
  pen.lineWidth = 5;
  pen.strokeStyle = MANDALA_COLOURS.discEdge;
  pen.stroke();
}

function drawBeadRing(pen, { count, radius, beadRadius }) {
  pen.fillStyle = MANDALA_COLOURS.bead;
  for (let i = 0; i < count; i++) {
    const angle = i * Math.PI * 2 / count;
    pen.beginPath();
    pen.arc(Math.cos(angle) * radius, Math.sin(angle) * radius, beadRadius, 0, Math.PI * 2);
    pen.fill();
  }
}

function drawSyllable(pen, text, sizePx) {
  pen.fillStyle = MANDALA_COLOURS.syllable;
  pen.textAlign = 'center';
  pen.textBaseline = 'middle';
  pen.font = `${sizePx}px "Tiro Devanagari Sanskrit", "Noto Serif Devanagari", serif`;
  pen.fillText(text, 0, sizePx * 0.09);   // Devanagari sits high on its baseline
}

// Scales the image to fill the canvas, cropping whichever side overflows.
function drawCoverImage(canvas, image) {
  const pen = canvas.getContext('2d');
  const scale = Math.max(canvas.width / image.width, canvas.height / image.height);
  const width = image.width * scale, height = image.height * scale;
  pen.clearRect(0, 0, canvas.width, canvas.height);
  pen.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
}

function useChosenImage(event) {
  const file = event.target.files[0];
  if (!file) return;
  const image = new Image();
  image.onload = () => { drawCoverImage(ui.artwork, image); URL.revokeObjectURL(image.src); };
  image.src = URL.createObjectURL(file);
}


/* ── Small maths ─────────────────────────────────────────────────────────── */

function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
function average(values) { return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0; }
function asPercent(fraction) { return Math.round(fraction * 100); }

function standardDeviation(values) {
  const mean = average(values);
  return Math.sqrt(average(values.map(v => (v - mean) ** 2)));
}

function rootMeanSquare(samples) {
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / samples.length);
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

// Moves `current` toward `target` by `fraction` of the gap (capped at the whole gap).
function approach(current, target, fraction) {
  return current + (target - current) * Math.min(1, fraction);
}


/* ── Start-up ────────────────────────────────────────────────────────────── */

ui.startButton.addEventListener('click', startSession);
ui.resetButton.addEventListener('click', resetReveal);
ui.imageInput.addEventListener('change', useChosenImage);

const drawDefaultArtwork = () => drawMandala(ui.artwork);
document.fonts.load('160px "Tiro Devanagari Sanskrit"').then(drawDefaultArtwork, drawDefaultArtwork);
