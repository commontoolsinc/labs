export const assert = (condition) => {
  if (!condition) {
    throw new Error("assertion failed.");
  }
};

export const bytesEqual = (a, b) => {
  let aLen = a.length;
  let bLen = b.length;
  if (aLen != bLen) return false;
  for (let i = 0; i < aLen; i++) {
    if (a[i] != b[i]) return false;
  }
  return true;
};
