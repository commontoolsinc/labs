/** Check if number is between min and max inclusive */
export const isBetweenInclusive = (min: number, max: number, n: number) => {
  return n >= min && n <= max;
};

/** Clamp number between min and max inclusive */
export const clamp = (n: number, min: number, max: number) => {
  if (max < min) throw TypeError("max must be >= min");
  return Math.min(Math.max(n, min), max);
};
