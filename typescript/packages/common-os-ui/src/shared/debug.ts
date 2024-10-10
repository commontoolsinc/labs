let isDebugging = true;

export const setDebug = (on: boolean) => {
  isDebugging = on;
};

export const debug = () => {
  return isDebugging;
};
