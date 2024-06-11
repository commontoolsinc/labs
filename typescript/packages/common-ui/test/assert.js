export const assert = (value, msg = "") => {
  console.assert(value, msg);
}

export const equal = (a, b, msg = "") => {
  console.assert(a === b, `${msg} ${a} !== ${b}`);
}

export const throws = (run, msg = "") => {
  try {
    run();
  } catch (e) {
    return;
  }
  console.assert(false, `${msg} ${a} !== ${b}`);
}