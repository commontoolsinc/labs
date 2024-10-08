export const classes = (classRecord: Record<string, boolean>) => {
  let toggledClasses: Array<string> = [];
  for (const [className, isActive] of Object.entries(classRecord)) {
    if (isActive) toggledClasses.push(className);
  }
  return toggledClasses.join(" ");
};

let isFlushScheduled = false;
const writes: Array<() => void> = [];

/**
 * Batch DOM writes to prevent layout thrashing.
 * Use: perform your DOM measurements outside the callback, in ordinary code,
 * then schedule any writes using `withWrites()`.
 * This will cause writes to be batched on next microtask. `withWrites` may
 * be called multiple times, and all writes will be batched.
 *
 * @example
 * let rect1 = el1.getBoundingClientRect();
 * withWrites(() => {
 *   // Do something with rect1
 * });
 *
 * let rect2 = el2.getBoundingClientRect();
 * withWrites(() => {
 *   // Do something with rect2
 * });
 */
export const withWrites = (write: () => void) => {
  writes.push(write);
  if (isFlushScheduled) return;

  isFlushScheduled = true;

  queueMicrotask(() => {
    for (const write of writes) {
      write();
    }
    writes.length = 0;

    isFlushScheduled = false;
  });
};
