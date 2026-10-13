/**
 * Browser guest of Ring Loops. It draws the rings on a canvas, plays the
 * placed notes on a Web Audio graph from a step clock that exists only in this
 * browser, and writes each placement to the shared state as one keyed cell, so
 * two people editing different cells never write the same value.
 */

import { connectFabric } from "@commonfabric/iframe-sandbox/guest";
import {
  DEFAULT_INPUT,
  DEFAULT_OUTPUT,
  DEFAULT_STATE,
  type PlacedNote,
} from "./contract.ts";
import {
  type Cell,
  cellAt,
  cellKey,
  type CellShape,
  cellShape,
  defaultColor,
  type DrumSound,
  drumSound,
  handTurn,
  laneLabel,
  laneMidi,
  type LiveNote,
  liveNotes,
  MAX_TEMPO_BPM,
  midiToFrequency,
  MIN_TEMPO_BPM,
  normalizeTempo,
  NOTE_COLORS,
  notesAtStep,
  positionAt,
  retimed,
  type Ring,
  ringBands,
  type RingLayout,
  ringLayoutOf,
  secondsPerStep,
  STEPS_PER_BEAT,
  stepsBetween,
  timeOfStep,
  toggleEdit,
  type Transport,
} from "./model.ts";

/** How far ahead of the audio clock notes are queued, in seconds. */
const LOOKAHEAD_SECONDS = 0.12;

/** Delay between pressing Play and the first step, in seconds. */
const START_DELAY_SECONDS = 0.06;

/** How long a cell stays lit after its note sounds, in seconds. */
const FLASH_SECONDS = 0.28;

/** Steps by which the echo trails the note it repeats. */
const ECHO_STEPS = 3;

/** Gain an envelope decays to, since an exponential ramp cannot reach zero. */
const SILENCE = 0.001;

/** Share of the canvas's half-width the outermost ring reaches. */
const RING_EXTENT = 0.97;

const TAU = 2 * Math.PI;

const HINT = "Click a cell to place a note, and click it again to remove it.";

/** The audio graph every voice plays into. */
interface AudioEngine {
  /** Context whose clock the step clock is anchored to. */
  readonly context: AudioContext;

  /** Volume control that every voice and the echo feed. */
  readonly master: GainNode;

  /** Input of the echo that the bell and pluck voices also feed. */
  readonly echo: DelayNode;

  /** One second of white noise that the drum voices read from. */
  readonly noise: AudioBuffer;
}

const fabric = connectFabric();
const input = fabric.cell<typeof DEFAULT_INPUT>("input");
const state = fabric.cell<typeof DEFAULT_STATE>("state");
const output = fabric.cell<typeof DEFAULT_OUTPUT>("output");
const notesCell = state.key("notes");

const root = document.querySelector<HTMLDivElement>("#root");
if (!root) throw new Error("Ring Loops needs a `#root` element.");

const abort = new AbortController();
const { signal } = abort;
let hydrated = false;
let disposed = false;
let authorId = "";
let layout: RingLayout | undefined;
let layoutErrorMessage: string | undefined;
let live: LiveNote[] = [];
let hoverCell: Cell | undefined;
let hoverRowIndex: number | undefined;
let audio: AudioEngine | undefined;
let transport: Transport | undefined;
let scheduledThrough = 0;
let animationFrame: number | undefined;
let tempoDraft: number | undefined;
let volumeDraft: number | undefined;
let clearArmed = false;
// Writes on their way to the shared state, by cell key. They are drawn and
// played ahead of the stored notes until the write settles.
const pendingEdits = new Map<string, PlacedNote | null>();
// Audio time at which each cell last sounded, by cell key.
const flashes = new Map<string, number>();

//
// Document
//

const app = document.createElement("main");
app.className = "app";
app.dataset.testid = "ring-loops";

const stage = document.createElement("section");
stage.className = "stage";
const canvas = document.createElement("canvas");
canvas.className = "rings";
canvas.dataset.testid = "ring-canvas";
canvas.dataset.ready = "false";
canvas.setAttribute(
  "aria-label",
  "Rings of note cells. Click a cell to place or remove a note.",
);
const readout = document.createElement("p");
readout.className = "readout";
readout.dataset.testid = "cell-readout";
readout.textContent = HINT;
stage.append(canvas, readout);

const drawing = contextOf(canvas);

const panel = document.createElement("section");
panel.className = "panel";

const heading = document.createElement("div");
const title = document.createElement("h1");
title.textContent = DEFAULT_INPUT.title;
const deck = document.createElement("p");
deck.className = "deck";
deck.textContent =
  "Everyone here shares the notes and the tempo. Playback runs in each browser on its own, so stop yours to edit while the others keep listening.";
heading.append(title, deck);

const playButton = document.createElement("button");
playButton.type = "button";
playButton.className = "play";
playButton.dataset.testid = "play-toggle";
playButton.textContent = "Play";
playButton.disabled = true;

const tempoSlider = document.createElement("input");
tempoSlider.type = "range";
tempoSlider.min = String(MIN_TEMPO_BPM);
tempoSlider.max = String(MAX_TEMPO_BPM);
tempoSlider.step = "1";
tempoSlider.disabled = true;
tempoSlider.dataset.testid = "tempo";
const tempoReadout = document.createElement("output");
const tempoField = makeField("Tempo, shared", tempoSlider, tempoReadout);

const volumeSlider = document.createElement("input");
volumeSlider.type = "range";
volumeSlider.min = "0";
volumeSlider.max = "1";
volumeSlider.step = "0.01";
volumeSlider.disabled = true;
volumeSlider.dataset.testid = "volume";
const volumeReadout = document.createElement("output");
const volumeField = makeField("Volume, yours", volumeSlider, volumeReadout);

const colorGroup = document.createElement("div");
const colorHeading = document.createElement("h2");
colorHeading.textContent = "Your note color";
const swatches = document.createElement("div");
swatches.className = "swatches";
const swatchButtons = NOTE_COLORS.map((color, index) => {
  const swatch = document.createElement("button");
  swatch.type = "button";
  swatch.className = "swatch";
  swatch.style.setProperty("--swatch", color);
  swatch.setAttribute("aria-label", `Note color ${index + 1}`);
  swatch.dataset.color = color;
  swatch.disabled = true;
  swatch.addEventListener("click", () => {
    clearError();
    void output.key("color").set(color).catch(showError);
  }, { signal });
  return swatch;
});
swatches.append(...swatchButtons);
colorGroup.append(colorHeading, swatches);

const ringGroup = document.createElement("div");
const ringHeading = document.createElement("h2");
ringHeading.textContent = "Rings, inner to outer";
const ringList = document.createElement("ul");
ringList.className = "ring-list";
ringGroup.append(ringHeading, ringList);

const clearButton = document.createElement("button");
clearButton.type = "button";
clearButton.className = "clear";
clearButton.dataset.testid = "clear-notes";
clearButton.disabled = true;

const status = document.createElement("p");
status.className = "status";
status.dataset.ready = "false";
status.dataset.testid = "ring-status";
status.textContent = "Joining the rings…";

const error = document.createElement("p");
error.className = "error";
error.role = "alert";
error.setAttribute("aria-live", "assertive");

panel.append(
  heading,
  playButton,
  tempoField,
  volumeField,
  colorGroup,
  ringGroup,
  clearButton,
  status,
  error,
);
app.append(stage, panel);
root.append(app);

/**
 * Returns the 2D drawing context of `canvas`.
 *
 * @throws {Error} When the browser provides none.
 */
function contextOf(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Ring Loops needs a 2D canvas.");
  return context;
}

/** Returns a labeled control with a readout of its value beside the label. */
function makeField(
  label: string,
  control: HTMLInputElement,
  value: HTMLOutputElement,
): HTMLLabelElement {
  const field = document.createElement("label");
  field.className = "field";
  const text = document.createElement("span");
  text.textContent = label;
  field.append(text, value, control);
  return field;
}

/** Shows `cause` in the alert beneath the controls. */
function showError(cause: unknown): void {
  layoutErrorMessage = undefined;
  error.textContent = cause instanceof Error ? cause.message : String(cause);
}

/**
 * Empties the alert, unless it holds the standing report of an invalid input.
 */
function clearError(): void {
  if (error.textContent === layoutErrorMessage) return;
  error.textContent = "";
}

//
// Settings in effect
//
// Each reads the stored value unless a control holds a draft the store has
// not confirmed yet.
//

/** Whether the guest has hydrated and holds a layout it can draw and play. */
function ready(): boolean {
  return hydrated && !disposed && layout !== undefined;
}

/**
 * Returns the tempo to play: the slider's while it is being moved, else the
 * shared one.
 */
function effectiveTempo(): number {
  return tempoDraft ??
    normalizeTempo(state.get()?.tempoBpm ?? DEFAULT_STATE.tempoBpm);
}

/**
 * Returns this user's volume from 0 to 1, or 0 where the stored one is not a
 * number.
 */
function effectiveVolume(): number {
  const stored = output.get()?.volume ?? DEFAULT_OUTPUT.volume;
  const volume = volumeDraft ?? stored;
  return Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 0;
}

/** Returns the color this user's notes are placed in. */
function effectiveColor(): string {
  return output.get()?.color ?? defaultColor(authorId);
}

/** Returns the identifiers of the rings this user has silenced. */
function mutedRingIds(): Set<string> {
  return new Set(output.get()?.mutedRingIds ?? []);
}

/** Returns the stored notes with the writes still on their way applied. */
function currentNotes(): Record<string, PlacedNote | null> {
  return { ...state.get()?.notes, ...Object.fromEntries(pendingEdits) };
}

//
// Audio
//

/** Builds the graph the voices play into, at the volume and tempo in effect. */
function createAudioEngine(): AudioEngine {
  const context = new AudioContext();
  const limiter = context.createDynamicsCompressor();
  limiter.threshold.value = -10;
  limiter.knee.value = 6;
  limiter.ratio.value = 12;
  limiter.connect(context.destination);

  const master = context.createGain();
  master.gain.value = effectiveVolume();
  master.connect(limiter);

  const echo = context.createDelay(2);
  echo.delayTime.value = ECHO_STEPS * secondsPerStep(effectiveTempo());
  const feedback = context.createGain();
  feedback.gain.value = 0.35;
  const echoLevel = context.createGain();
  echoLevel.gain.value = 0.3;
  echo.connect(feedback);
  feedback.connect(echo);
  echo.connect(echoLevel);
  echoLevel.connect(master);

  const noise = context.createBuffer(1, context.sampleRate, context.sampleRate);
  const samples = noise.getChannelData(0);
  for (let index = 0; index < samples.length; index++) {
    samples[index] = Math.random() * 2 - 1;
  }
  return { context, master, echo, noise };
}

/**
 * Returns a gain that reaches `peak` at `time`, after `attack` seconds where
 * one is given, and decays to silence over the `seconds` that follow.
 */
function envelope(
  engine: AudioEngine,
  time: number,
  peak: number,
  seconds: number,
  attack = 0,
): GainNode {
  const gain = engine.context.createGain();
  if (attack > 0) {
    gain.gain.setValueAtTime(SILENCE, time);
    gain.gain.linearRampToValueAtTime(peak, time + attack);
  } else {
    gain.gain.setValueAtTime(peak, time);
  }
  gain.gain.exponentialRampToValueAtTime(SILENCE, time + attack + seconds);
  return gain;
}

/**
 * Returns an oscillator that sounds from `time` for `seconds`, gliding from
 * `startHertz` to `endHertz` where the two differ.
 */
function tone(
  engine: AudioEngine,
  type: OscillatorType,
  time: number,
  seconds: number,
  startHertz: number,
  endHertz = startHertz,
): OscillatorNode {
  const oscillator = engine.context.createOscillator();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(startHertz, time);
  if (endHertz !== startHertz) {
    oscillator.frequency.exponentialRampToValueAtTime(endHertz, time + seconds);
  }
  oscillator.start(time);
  oscillator.stop(time + seconds);
  return oscillator;
}

/** Returns a source of white noise that sounds from `time` for `seconds`. */
function noiseBurst(
  engine: AudioEngine,
  time: number,
  seconds: number,
): AudioBufferSourceNode {
  const source = engine.context.createBufferSource();
  source.buffer = engine.noise;
  source.start(time);
  source.stop(time + seconds);
  return source;
}

/**
 * Returns a filter whose cutoff glides from `startHertz` at `time` to
 * `endHertz` over `seconds`, or holds at `startHertz` where the two agree.
 */
function filter(
  engine: AudioEngine,
  type: BiquadFilterType,
  time: number,
  seconds: number,
  startHertz: number,
  endHertz = startHertz,
): BiquadFilterNode {
  const node = engine.context.createBiquadFilter();
  node.type = type;
  node.frequency.setValueAtTime(startHertz, time);
  if (endHertz !== startHertz) {
    node.frequency.exponentialRampToValueAtTime(endHertz, time + seconds);
  }
  return node;
}

/**
 * Plays `source` through `chain` into the master volume, and into the echo as
 * well when `echo` is set. The nodes are disconnected when the source ends.
 */
function route(
  engine: AudioEngine,
  source: AudioScheduledSourceNode,
  chain: readonly AudioNode[],
  echo = false,
): void {
  let tail: AudioNode = source;
  for (const node of chain) {
    tail.connect(node);
    tail = node;
  }
  tail.connect(engine.master);
  if (echo) tail.connect(engine.echo);
  source.addEventListener("ended", () => {
    source.disconnect();
    for (const node of chain) node.disconnect();
  }, { once: true });
}

/** Plays one sound of the drum kit at audio time `time`. */
function playDrum(engine: AudioEngine, sound: DrumSound, time: number): void {
  switch (sound) {
    case "kick":
      route(engine, tone(engine, "sine", time, 0.32, 150, 42), [
        envelope(engine, time, 0.9, 0.32),
      ]);
      break;
    case "snare":
      route(engine, noiseBurst(engine, time, 0.18), [
        filter(engine, "bandpass", time, 0.18, 1800),
        envelope(engine, time, 0.55, 0.18),
      ]);
      route(engine, tone(engine, "triangle", time, 0.1, 190, 120), [
        envelope(engine, time, 0.4, 0.1),
      ]);
      break;
    case "hat":
      route(engine, noiseBurst(engine, time, 0.06), [
        filter(engine, "highpass", time, 0.06, 7000),
        envelope(engine, time, 0.28, 0.06),
      ]);
      break;
    case "clap":
      // Three bursts a few milliseconds apart read as several hands.
      for (
        const [offset, seconds] of [[0, 0.02], [0.012, 0.02], [0.024, 0.16]]
      ) {
        route(engine, noiseBurst(engine, time + offset, seconds), [
          filter(engine, "bandpass", time + offset, seconds, 1200),
          envelope(engine, time + offset, 0.4, seconds),
        ]);
      }
      break;
    case "tom":
      route(engine, tone(engine, "sine", time, 0.26, 220, 105), [
        envelope(engine, time, 0.7, 0.26),
      ]);
      break;
  }
}

/** Plays `lane` of `ring` at audio time `time`, on the ring's voice. */
function playNote(
  engine: AudioEngine,
  rings: RingLayout,
  ring: Ring,
  lane: number,
  time: number,
): void {
  if (ring.voice === "drums") {
    playDrum(engine, drumSound(lane), time);
    return;
  }
  const hertz = midiToFrequency(laneMidi(rings, ring, lane));
  switch (ring.voice) {
    case "bass":
      route(engine, tone(engine, "sawtooth", time, 0.5, hertz), [
        filter(engine, "lowpass", time, 0.3, 900, 180),
        envelope(engine, time, 0.5, 0.5, 0.004),
      ]);
      break;
    case "pluck":
      route(engine, tone(engine, "square", time, 0.42, hertz), [
        filter(engine, "lowpass", time, 0.3, 3200, 500),
        envelope(engine, time, 0.2, 0.42, 0.003),
      ], true);
      break;
    case "bell": {
      // A modulator at a ratio that is not a whole number gives the carrier
      // the inharmonic partials of struck metal.
      const carrier = tone(engine, "sine", time, 1.6, hertz);
      const modulator = tone(engine, "sine", time, 1.6, hertz * 3.5);
      const depth = envelope(engine, time, hertz * 2, 0.5);
      modulator.connect(depth);
      depth.connect(carrier.frequency);
      modulator.addEventListener("ended", () => {
        modulator.disconnect();
        depth.disconnect();
      }, { once: true });
      route(engine, carrier, [envelope(engine, time, 0.22, 1.6, 0.004)], true);
      break;
    }
  }
}

/**
 * Sounds the note of `cell` now, where audio is running and its ring is not
 * muted.
 */
function audition(cell: Cell): void {
  if (!audio || !layout || audio.context.state !== "running") return;
  const ring = layout.rings[cell.ringIndex];
  if (mutedRingIds().has(ring.id)) return;
  playNote(audio, layout, ring, cell.lane, audio.context.currentTime);
}

/**
 * Brings the audio graph and the running clock to the volume and tempo in
 * effect.
 */
function applySettings(): void {
  if (!audio) return;
  const now = audio.context.currentTime;
  const tempo = effectiveTempo();
  audio.master.gain.setTargetAtTime(effectiveVolume(), now, 0.02);
  audio.echo.delayTime.setTargetAtTime(
    ECHO_STEPS * secondsPerStep(tempo),
    now,
    0.05,
  );
  if (transport && transport.tempoBpm !== tempo) {
    transport = retimed(transport, now, tempo);
  }
}

//
// Step clock
//

/**
 * Starts the step clock at step 0, building the audio graph on the first call.
 *
 * @throws {Error} When the browser leaves the audio context suspended.
 */
async function startPlayback(): Promise<void> {
  if (!ready() || transport) return;
  audio ??= createAudioEngine();
  await audio.context.resume();
  if (disposed || transport) return;
  if (audio.context.state !== "running") {
    throw new Error("The browser has not started audio. Press Play again.");
  }
  applySettings();
  transport = {
    anchorStep: 0,
    anchorTime: audio.context.currentTime + START_DELAY_SECONDS,
    tempoBpm: effectiveTempo(),
  };
  scheduledThrough = 0;
  renderControls();
  requestFrame();
}

/** Stops the step clock and returns every hand to the top. */
function stopPlayback(): void {
  transport = undefined;
  flashes.clear();
  renderControls();
  requestFrame();
}

/**
 * Queues every note due between the steps already queued and the lookahead
 * horizon. Steps the clock passed while no frame ran, as in a hidden tab, are
 * left unplayed.
 */
function scheduleAhead(): void {
  if (!transport || !audio || !layout) return;
  const now = audio.context.currentTime;
  const from = Math.max(scheduledThrough, positionAt(transport, now));
  const through = positionAt(transport, now + LOOKAHEAD_SECONDS);
  const muted = mutedRingIds();
  for (const step of stepsBetween(from, through)) {
    const time = timeOfStep(transport, step);
    for (const { ringIndex, note } of notesAtStep(layout, live, step)) {
      const ring = layout.rings[ringIndex];
      if (muted.has(ring.id)) continue;
      playNote(audio, layout, ring, note.lane, time);
      flashes.set(cellKey(note.ringId, note.step, note.lane), time);
    }
  }
  scheduledThrough = Math.max(scheduledThrough, through);
}

/** Runs one frame: queues the notes coming due, then draws. */
function frame(): void {
  animationFrame = undefined;
  if (disposed) return;
  try {
    scheduleAhead();
    draw();
  } catch (cause) {
    transport = undefined;
    showError(cause);
    renderControls();
    return;
  }
  if (transport) animationFrame = requestAnimationFrame(frame);
}

/** Asks for a frame, unless one is already on its way. */
function requestFrame(): void {
  if (animationFrame === undefined && !disposed) {
    animationFrame = requestAnimationFrame(frame);
  }
}

//
// Canvas
//

/** Returns the outermost ring's radius on a canvas `size` pixels wide. */
function ringRadius(size: number): number {
  return size / 2 * RING_EXTENT;
}

/** Fits the square canvas into the stage, at the display's pixel density. */
function resizeCanvas(): void {
  const style = getComputedStyle(stage);
  const width = stage.clientWidth - parseFloat(style.paddingLeft) -
    parseFloat(style.paddingRight);
  const height = stage.clientHeight - parseFloat(style.paddingTop) -
    parseFloat(style.paddingBottom);
  const size = Math.max(0, Math.floor(Math.min(width, height)));
  const density = globalThis.devicePixelRatio || 1;
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  canvas.width = Math.round(size * density);
  canvas.height = Math.round(size * density);
}

/** Returns the cell under a pointer event on the canvas, if it is over one. */
function cellUnder(event: MouseEvent): Cell | undefined {
  if (!layout) return undefined;
  const size = canvas.clientWidth;
  const radius = ringRadius(size);
  if (radius <= 0) return undefined;
  return cellAt(
    layout,
    (event.offsetX - size / 2) / radius,
    (event.offsetY - size / 2) / radius,
  );
}

/** Returns the canvas angle of a fraction of a turn clockwise from the top. */
function angleOf(turn: number): number {
  return turn * TAU - Math.PI / 2;
}

/**
 * Traces the sector `shape` as the current path, pulled in by `inset` pixels
 * on every side so that neighboring cells do not touch.
 */
function traceSector(shape: CellShape, radius: number, inset: number): void {
  const outer = shape.outer * radius - inset;
  const inner = shape.inner * radius + inset;
  const start = angleOf(shape.startTurn);
  const end = angleOf(shape.endTurn);
  drawing.beginPath();
  drawing.arc(0, 0, outer, start + inset / outer, end - inset / outer);
  drawing.arc(0, 0, inner, end - inset / inner, start + inset / inner, true);
  drawing.closePath();
}

/** Strokes a radial line across the radii `inner` to `outer`, at `turn`. */
function strokeRadial(inner: number, outer: number, turn: number): void {
  const angle = angleOf(turn);
  drawing.beginPath();
  drawing.moveTo(inner * Math.cos(angle), inner * Math.sin(angle));
  drawing.lineTo(outer * Math.cos(angle), outer * Math.sin(angle));
  drawing.stroke();
}

/**
 * Returns how brightly a cell is lit at `now` by its last sounding, from 0 to
 * 1.
 */
function flashAt(key: string, now: number): number {
  const time = flashes.get(key);
  if (time === undefined || now < time) return 0;
  const age = now - time;
  if (age >= FLASH_SECONDS) {
    flashes.delete(key);
    return 0;
  }
  return 1 - age / FLASH_SECONDS;
}

/**
 * Draws the rings with their lanes and steps, the notes, the hovered cell, the
 * hand of each ring, and the tempo in the hub.
 */
function draw(): void {
  const context = drawing;
  const size = canvas.clientWidth;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (!layout || !hydrated || size <= 0) return;

  const density = canvas.width / size;
  const radius = ringRadius(size);
  context.setTransform(density, 0, 0, density, 0, 0);
  context.translate(size / 2, size / 2);

  const bands = ringBands(layout.rings.length);
  const muted = mutedRingIds();
  const now = audio?.context.currentTime ?? 0;
  const position = transport ? Math.max(0, positionAt(transport, now)) : 0;
  const highlighted = hoverRowIndex ?? hoverCell?.ringIndex;

  for (const [ringIndex, ring] of layout.rings.entries()) {
    const band = bands[ringIndex];
    const inner = band.inner * radius;
    const outer = band.outer * radius;
    context.globalAlpha = muted.has(ring.id) ? 0.4 : 1;

    context.beginPath();
    context.arc(0, 0, outer, 0, TAU);
    context.arc(0, 0, inner, 0, TAU, true);
    context.fillStyle = ringIndex === highlighted ? "#ffffff1c" : "#ffffff0d";
    context.fill();

    context.lineWidth = 1;
    context.strokeStyle = "#ffffff12";
    for (let lane = 1; lane < layout.lanes; lane++) {
      context.beginPath();
      context.arc(0, 0, inner + (outer - inner) * lane / layout.lanes, 0, TAU);
      context.stroke();
    }
    for (let step = 0; step < ring.steps; step++) {
      context.strokeStyle = step === 0
        ? "#ffffff80"
        : step % STEPS_PER_BEAT === 0
        ? "#ffffff38"
        : "#ffffff14";
      strokeRadial(inner, outer, step / ring.steps);
    }
  }

  for (const { ringIndex, note } of live) {
    const key = cellKey(note.ringId, note.step, note.lane);
    const flash = flashAt(key, now);
    const dimmed = muted.has(layout.rings[ringIndex].id);
    traceSector(cellShape(layout, { ringIndex, ...note }), radius, 1.5);
    context.globalAlpha = dimmed ? 0.3 : pendingEdits.has(key) ? 0.6 : 0.92;
    context.shadowColor = note.color;
    context.shadowBlur = 20 * flash;
    context.fillStyle = note.color;
    context.fill();
    context.shadowBlur = 0;
    if (flash > 0) {
      context.globalAlpha = 0.7 * flash;
      context.fillStyle = "#ffffff";
      context.fill();
    }
  }
  context.globalAlpha = 1;

  if (hoverCell) {
    traceSector(cellShape(layout, hoverCell), radius, 1.5);
    context.globalAlpha = 0.3;
    context.fillStyle = effectiveColor();
    context.fill();
    context.globalAlpha = 1;
    context.lineWidth = 1.5;
    context.strokeStyle = "#ffffff";
    context.stroke();
  }

  context.lineCap = "round";
  context.lineWidth = 2.5;
  context.strokeStyle = transport ? "#ffffff" : "#ffffff66";
  for (const [ringIndex, ring] of layout.rings.entries()) {
    const band = bands[ringIndex];
    strokeRadial(
      band.inner * radius,
      band.outer * radius,
      handTurn(position, ring.steps),
    );
  }
  context.lineCap = "butt";

  const hub = bands[0].inner * radius;
  context.fillStyle = "#eef0f8";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.font = `650 ${hub * 0.62}px Inter, ui-sans-serif, system-ui`;
  context.fillText(String(Math.round(effectiveTempo())), 0, -hub * 0.1);
  context.fillStyle = "#a3abc7";
  context.font = `600 ${hub * 0.24}px Inter, ui-sans-serif, system-ui`;
  context.fillText("BPM", 0, hub * 0.42);
}

//
// Controls
//

/** Rebuilds the list of rings, one row with a mute control for each. */
function rebuildRingRows(): void {
  ringList.replaceChildren();
  if (!layout) return;
  for (const [index, ring] of layout.rings.entries()) {
    const row = document.createElement("li");
    row.className = "ring-row";
    const text = document.createElement("div");
    const name = document.createElement("span");
    name.className = "ring-name";
    name.textContent = ring.label;
    const detail = document.createElement("span");
    detail.className = "ring-detail";
    const beats = ring.steps / STEPS_PER_BEAT;
    detail.textContent = `${beats} ${beats === 1 ? "beat" : "beats"} · ${
      ring.voice === "drums" ? "drum kit" : ring.voice
    }`;
    text.append(name, detail);

    const mute = document.createElement("button");
    mute.type = "button";
    mute.dataset.testid = `mute-${index}`;
    mute.addEventListener("click", () => {
      const muted = mutedRingIds();
      if (!muted.delete(ring.id)) muted.add(ring.id);
      clearError();
      void output.key("mutedRingIds").set([...muted]).catch(showError);
    }, { signal });

    row.addEventListener("pointerenter", () => {
      hoverRowIndex = index;
      requestFrame();
    }, { signal });
    row.addEventListener("pointerleave", () => {
      if (hoverRowIndex === index) hoverRowIndex = undefined;
      requestFrame();
    }, { signal });
    row.append(text, mute);
    ringList.append(row);
  }
}

/** Brings every control in the panel up to date with the settings in effect. */
function renderControls(): void {
  const isReady = ready();
  title.textContent = input.get()?.title ?? DEFAULT_INPUT.title;
  canvas.dataset.ready = String(isReady);

  playButton.disabled = !isReady;
  playButton.textContent = transport ? "Stop" : "Play";
  playButton.setAttribute("aria-pressed", String(transport !== undefined));

  const tempo = effectiveTempo();
  tempoSlider.disabled = !isReady;
  if (tempoDraft === undefined) tempoSlider.value = String(tempo);
  tempoReadout.textContent = `${Math.round(tempo)} BPM`;

  const volume = effectiveVolume();
  volumeSlider.disabled = !isReady;
  if (volumeDraft === undefined) volumeSlider.value = String(volume);
  volumeReadout.textContent = `${Math.round(volume * 100)}%`;

  const color = isReady ? effectiveColor() : undefined;
  for (const swatch of swatchButtons) {
    swatch.disabled = !isReady;
    swatch.setAttribute("aria-pressed", String(swatch.dataset.color === color));
  }

  const muted = mutedRingIds();
  for (const [index, row] of [...ringList.children].entries()) {
    const ring = layout?.rings[index];
    const mute = row.querySelector("button");
    if (!ring || !(row instanceof HTMLElement) || !mute) continue;
    const isMuted = muted.has(ring.id);
    row.dataset.muted = String(isMuted);
    row.dataset.hover = String(hoverCell?.ringIndex === index);
    mute.disabled = !isReady;
    mute.textContent = isMuted ? "Muted" : "Mute";
    mute.setAttribute("aria-pressed", String(isMuted));
    mute.setAttribute(
      "aria-label",
      `${isMuted ? "Unmute" : "Mute"} ${ring.label} for yourself`,
    );
  }

  clearButton.disabled = !isReady;
  clearButton.dataset.armed = String(clearArmed);
  clearButton.textContent = clearArmed
    ? "Click again to clear everyone's notes"
    : "Clear all notes";

  if (isReady) {
    status.textContent = `${live.length} ${
      live.length === 1 ? "note" : "notes"
    } on the rings`;
  }
  status.dataset.ready = String(isReady);
}

/** Describes the hovered cell beneath the canvas, or shows the hint. */
function renderReadout(): void {
  if (!layout || !hoverCell) {
    readout.textContent = HINT;
    return;
  }
  const ring = layout.rings[hoverCell.ringIndex];
  readout.textContent = `${ring.label} · step ${
    hoverCell.step + 1
  } of ${ring.steps} · ${laneLabel(layout, ring, hoverCell.lane)}`;
}

/** Records the cell under the pointer, and redraws where it changed. */
function setHover(cell: Cell | undefined): void {
  if (
    cell?.ringIndex === hoverCell?.ringIndex &&
    cell?.step === hoverCell?.step &&
    cell?.lane === hoverCell?.lane
  ) {
    return;
  }
  hoverCell = cell;
  renderReadout();
  renderControls();
  requestFrame();
}

/**
 * Brings the notes, the audio settings, the controls, and the canvas up to
 * date.
 */
function refresh(): void {
  live = ready() && layout ? liveNotes(layout, currentNotes()) : [];
  applySettings();
  renderControls();
  requestFrame();
}

/**
 * Derives the layout from the input, and stops playback where it is invalid.
 */
function adoptInput(): void {
  const value = input.get();
  if (hydrated && value) {
    try {
      layout = ringLayoutOf(value);
      if (error.textContent === layoutErrorMessage) error.textContent = "";
      layoutErrorMessage = undefined;
    } catch (cause) {
      layout = undefined;
      transport = undefined;
      showError(cause);
      layoutErrorMessage = error.textContent ?? undefined;
      status.textContent = "These rings cannot be drawn";
    }
    hoverCell = undefined;
    hoverRowIndex = undefined;
    rebuildRingRows();
    renderReadout();
  }
  refresh();
}

//
// Shared writes
//

/**
 * Places or removes the note of `cell`. The cell shows its new content at
 * once, and takes no second toggle until the write has settled.
 */
function toggleCell(cell: Cell): void {
  if (!ready() || !layout) return;
  const edit = toggleEdit(
    layout,
    currentNotes(),
    cell,
    authorId,
    effectiveColor(),
  );
  if (pendingEdits.has(edit.key)) return;
  clearError();
  pendingEdits.set(edit.key, edit.value);
  if (edit.value) audition(cell);
  refresh();
  // The pull brings the stored notes up to the write before the pending copy
  // is dropped, so the cell does not show its old content in between.
  void notesCell.key(edit.key).set(edit.value).then(() => state.pull())
    .catch(showError).finally(() => {
      pendingEdits.delete(edit.key);
      refresh();
    });
}

/** Returns the clear control to its first step, where it was armed. */
function disarmClear(): void {
  if (!clearArmed) return;
  clearArmed = false;
  renderControls();
}

/**
 * Releases what the guest holds: its listeners and sinks, the frame it asked
 * for, the audio context, and the bridge.
 */
function teardown(): void {
  if (disposed) return;
  disposed = true;
  abort.abort();
  stops.forEach((stop) => stop());
  resizeObserver.disconnect();
  if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
  animationFrame = undefined;
  transport = undefined;
  void audio?.context.close().catch(() => undefined);
  fabric.disconnect();
}

const resizeObserver = new ResizeObserver(() => {
  resizeCanvas();
  requestFrame();
});
resizeObserver.observe(stage);

const stops = [
  input.sink(adoptInput),
  state.sink(refresh),
  output.sink(refresh),
];

canvas.addEventListener("pointermove", (event) => setHover(cellUnder(event)), {
  signal,
});
canvas.addEventListener("pointerleave", () => setHover(undefined), { signal });
canvas.addEventListener("click", (event) => {
  const cell = cellUnder(event);
  if (cell) toggleCell(cell);
}, { signal });

playButton.addEventListener("click", () => {
  clearError();
  if (transport) {
    stopPlayback();
  } else {
    void startPlayback().catch(showError);
  }
}, { signal });

tempoSlider.addEventListener("input", () => {
  tempoDraft = Number(tempoSlider.value);
  refresh();
}, { signal });
tempoSlider.addEventListener("change", () => {
  const tempo = Number(tempoSlider.value);
  tempoDraft = tempo;
  clearError();
  void state.key("tempoBpm").set(tempo).then(() => state.pull())
    .catch(showError).finally(() => {
      if (tempoDraft === tempo) tempoDraft = undefined;
      refresh();
    });
}, { signal });

volumeSlider.addEventListener("input", () => {
  volumeDraft = Number(volumeSlider.value);
  refresh();
}, { signal });
volumeSlider.addEventListener("change", () => {
  const volume = Number(volumeSlider.value);
  volumeDraft = volume;
  clearError();
  void output.key("volume").set(volume).then(() => output.pull())
    .catch(showError).finally(() => {
      if (volumeDraft === volume) volumeDraft = undefined;
      refresh();
    });
}, { signal });

clearButton.addEventListener("click", () => {
  if (!clearArmed) {
    clearArmed = true;
    renderControls();
    return;
  }
  clearArmed = false;
  clearError();
  void notesCell.set({}).then(() => state.pull()).catch(showError)
    .finally(refresh);
  renderControls();
}, { signal });
clearButton.addEventListener("blur", disarmClear, { signal });
clearButton.addEventListener("pointerleave", disarmClear, { signal });

globalThis.addEventListener("pagehide", teardown, { once: true, signal });

void (async () => {
  try {
    await Promise.all([input.pull(), state.pull(), output.pull()]);
    await Promise.all([
      state.initialize(DEFAULT_STATE),
      output.initialize(DEFAULT_OUTPUT),
    ]);
    const resolvedOutput = await output.resolve();
    authorId = resolvedOutput.identity?.instanceId ?? "";
    if (!authorId) {
      throw new Error("The per-user settings have no resolved identity.");
    }
    if (disposed) return;
    hydrated = true;
    adoptInput();
  } catch (cause) {
    showError(cause);
    status.textContent = "Could not join the rings";
  }
})();
