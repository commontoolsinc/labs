/**
 * seal-liveness — the shared, host-held "session clock + cursor channel" that
 * makes verified identity seals feel *alive* in a way a sandboxed pattern can't
 * reproduce.
 *
 * Two anti-forgery properties come from here:
 *
 *  1. LOCKSTEP. The slow ring rotation and the intrinsic shimmer sweep are CSS
 *     animations seeded to a single shared `epoch` via a negative
 *     `animation-delay`. Every verified seal on screen therefore moves in
 *     unison regardless of when it mounted — a late seal joins the chorus in
 *     phase. A pattern can copy the keyframes but cannot read our epoch, so its
 *     lookalike sings to its own beat.
 *
 *  2. CURSOR SHEEN. One global `pointermove` listener + one rAF loop drive a
 *     reflective hotspot on every registered seal — and it responds even when
 *     the cursor is nowhere near the seal. A sandboxed pattern only receives
 *     pointer events inside its own iframe, so a forgery cannot glint toward a
 *     cursor that is elsewhere on screen.
 *
 * Cost is bounded: the lockstep animations are pure CSS (no per-frame JS); the
 * cursor loop runs only while ≥1 seal is registered, touches only registered
 * (on-screen, verified) seals, and skips writes for seals the cursor is far
 * from. Under `prefers-reduced-motion` the cursor loop never starts and the CSS
 * animations are disabled by the component's stylesheet.
 */

/** Rotation period of the conic aura ring (ms). Slow — a drift, not a spin. */
export const SEAL_SPIN_PERIOD_MS = 26_000;
/** Sweep period of the intrinsic shimmer band (ms). */
export const SEAL_GLOW_PERIOD_MS = 7_000;

const nowMs = (): number => globalThis.performance?.now?.() ?? 0;

// A single shared origin captured on first use. All seeded delays are measured
// from here, so every seal's animation phase is a pure function of this epoch.
let epoch = 0;
let epochInit = false;
const ensureEpoch = (): number => {
  if (!epochInit) {
    epoch = nowMs();
    epochInit = true;
  }
  return epoch;
};

/** Negative animation-delay that puts a freshly-applied animation into the
 * shared phase for `periodMs`, so it lines up with seals that started earlier.
 * Evaluate the epoch first so `elapsed` is never negative (which would push the
 * animation's start into the future instead of seeding it into phase). */
const seededDelay = (periodMs: number): string => {
  const e = ensureEpoch();
  const elapsed = Math.max(0, nowMs() - e);
  return `${-(elapsed % periodMs)}ms`;
};

export const sealSpinDelay = (): string => seededDelay(SEAL_SPIN_PERIOD_MS);
export const sealGlowDelay = (): string => seededDelay(SEAL_GLOW_PERIOD_MS);

export const prefersReducedMotion = (): boolean =>
  globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;

/**
 * Implemented by a seal that wants cursor-driven sheen. `updateSeal` is called
 * once per animation frame while registered, with the latest host cursor
 * position (viewport px) and the frame timestamp.
 */
export interface SealLivenessClient {
  updateSeal(cursorX: number, cursorY: number, frameMs: number): void;
}

const clients = new Set<SealLivenessClient>();
let cursorX = -1e6;
let cursorY = -1e6;
let rafId = 0;
let listening = false;

const onPointerMove = (e: PointerEvent): void => {
  cursorX = e.clientX;
  cursorY = e.clientY;
};

const teardown = (): void => {
  if (listening) {
    globalThis.removeEventListener("pointermove", onPointerMove);
    listening = false;
  }
  if (rafId) {
    globalThis.cancelAnimationFrame(rafId);
    rafId = 0;
  }
};

const tick = (t: number): void => {
  rafId = 0;
  for (const c of clients) c.updateSeal(cursorX, cursorY, t);
  if (clients.size > 0) {
    rafId = globalThis.requestAnimationFrame(tick);
  } else {
    teardown();
  }
};

/** Register a verified seal for cursor sheen. No-op under reduced motion. */
export const registerSeal = (client: SealLivenessClient): void => {
  if (prefersReducedMotion()) return;
  // Cursor sheen needs a real animation loop; bail in non-browser envs (SSR,
  // unit tests) rather than throwing on a missing requestAnimationFrame.
  if (typeof globalThis.requestAnimationFrame !== "function") return;
  clients.add(client);
  if (!listening) {
    globalThis.addEventListener("pointermove", onPointerMove, { passive: true });
    listening = true;
  }
  if (!rafId) rafId = globalThis.requestAnimationFrame(tick);
};

export const unregisterSeal = (client: SealLivenessClient): void => {
  if (clients.delete(client) && clients.size === 0) teardown();
};
