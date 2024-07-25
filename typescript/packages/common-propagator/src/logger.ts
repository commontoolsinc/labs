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
export const warn = (msg: unknown) => {
  console.warn(msg);
};

/** Log if debugging is on */
export const debug = (msg: object) => {
  if (isDebug) {
    console.debug({ ...msg });
  }
};
