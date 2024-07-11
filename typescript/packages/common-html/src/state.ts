/** A simple reactive state cell without any scheduling */
export const state = <T>(name: string, value: T) => {
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

  return {
    get name() {
      return name;
    },
    get,
    sink,
    send
  };
};

/** A simple reactive event stream without any scheduling */
export const stream = <T>(name: string) => {
  const listeners = new Set<(value: T) => void>();

  const sink = (callback: (value: T) => void) => {
    listeners.add(callback);
    return () => {
      listeners.delete(callback);
    };
  }

  const send = (value: T) => {
    for (const listener of listeners) {
      listener(value);
    }
  }

  return {
    get name() {
      return name;
    },
    sink,
    send
  };
};

export default state;