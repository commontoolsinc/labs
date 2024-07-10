/** A simple reactive state cell without any scheduling */
export const state = <T>(value: T) => {
  let state = value;
  const listeners = new Set<(value: T) => void>();

  const get = () => state;

  const sink = (callback: (value: T) => void) => {
    listeners.add(callback);
    callback(state);
    return () => {
      listeners.delete(callback);
    };
  }

  const send = (value: T) => {
    state = value;
    for (const listener of listeners) {
      listener(state);
    }
  }

  return { get, sink, send };
};

export default state;