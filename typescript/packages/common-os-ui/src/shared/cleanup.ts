export type Cleanup = () => void;

export const createCleanupGroup = () => {
  const cleanups: Set<Cleanup> = new Set();

  const add = (cleanup: Cleanup) => {
    cleanups.add(cleanup);
  };

  const cleanup = () => {
    for (const cleanup of cleanups) {
      cleanup();
    }
    cleanups.clear();
  };

  return { add, cleanup };
};
