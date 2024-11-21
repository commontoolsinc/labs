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

export const debug = () => isDebug;

export default debug;
