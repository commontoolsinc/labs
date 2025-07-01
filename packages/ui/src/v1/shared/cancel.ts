export type CancelGroup = {
  add: (fn: () => void) => void;
  cancel: () => void;
};

export function createCancelGroup(): CancelGroup {
  const callbacks: Array<() => void> = [];
  
  return {
    add: (fn: () => void) => {
      callbacks.push(fn);
    },
    cancel: () => {
      for (const fn of callbacks) {
        fn();
      }
      callbacks.length = 0;
    }
  };
}