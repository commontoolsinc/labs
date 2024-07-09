/** Is debug logging on? */
let isDebug = false;

/**
 * Turn on debug logging
 * @example
 * import { setDebug } from "curly";
 *
 * setDebug(true);
 */
export const setDebug = (value: boolean) => {
  isDebug = value;
};


/** Log warning */
export const warn = (...args: unknown[]) => {
  console.warn(...args);
};

/** Log if debugging is on */
export const debug = (...args: unknown[]) => {
  if (isDebug) {
    console.debug(...args);
  }
};