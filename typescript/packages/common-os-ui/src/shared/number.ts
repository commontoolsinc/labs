/** Check if number is between min and max inclusive */
export const isBetweenInclusive = (min: number, max: number, n: number) => {
  return n >= min && n <= max;
};

/** Clamp number between min and max inclusive */
export const clamp = (min: number, max: number, n: number) => {
  if (max < min) throw TypeError("max must be >= min");
  return Math.min(Math.max(n, min), max);
};
