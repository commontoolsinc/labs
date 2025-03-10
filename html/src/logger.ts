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
    if (typeof args[0] === "function") {
      const result = args[0]();
      if (Array.isArray(result)) console.debug(...result);
      else console.debug(result);
    } else {
      console.debug(...args);
    }
  }
};
