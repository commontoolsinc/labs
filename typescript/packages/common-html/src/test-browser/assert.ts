export const assert = (condition: boolean, msg = "") => {
  console.assert(condition, msg);
};

export const equal = (a: unknown, b: unknown, msg = "") => {
  console.assert(a === b, `${msg} ${a} !== ${b}`);
};

export const throws = (run: () => void, msg = "") => {
  try {
    run();
  } catch (e) {
    return;
  }
  console.assert(false, msg);
};
