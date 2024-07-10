export const assert = (condition: boolean, msg = "") => {
  console.assert(condition, msg);
}

export const assertEqual = (a: unknown, b: unknown, msg = "") => {
  console.assert(a === b, `${msg} ${a} !== ${b}`);
}

export const assertThrows = (run: () => void, msg = "") => {
  try {
    run();
  } catch (e) {
    return;
  }
  console.assert(false, msg);
}