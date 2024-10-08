let isFlushScheduled = false;
const reads: Array<() => () => void> = [];
const writes: Array<() => void> = [];

/**
 * Batch DOM reads and writes to prevent layout thrashing.
 * measure takes a callback which is expected to read from the DOM and return
 * another callback to write to the DOM.
 * Reads and writes are batched on microtask and sequenced so that all reads
 * run and then all writes run, preventing layout thrashing.
 */
export const fastdom = (read: () => () => void) => {
  reads.push(read);
  if (isFlushScheduled) return;

  isFlushScheduled = true;

  queueMicrotask(() => {
    for (const read of reads) {
      const write = read();
      writes.push(write);
    }
    reads.length = 0;

    for (const write of writes) {
      write();
    }
    writes.length = 0;

    isFlushScheduled = false;
  });
};

export default fastdom;
