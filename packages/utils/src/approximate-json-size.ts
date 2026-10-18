/**
 * A cheap measure of how much a value would weigh as JSON text, for a
 * diagnostic that wants to rank values by size without encoding them. The
 * walk allocates nothing beyond its own stack, so a value measured here
 * leaves the heap as it found it, which is what makes it safe to run inside
 * a process that is already short of memory.
 */

/** What a walk measured. */
export type ApproximateJsonSize = {
  /**
   * The approximate length of the value's JSON text, in UTF-16 code units:
   * a string its length and quotes, a number eight, a key its length, quotes
   * and colon, a container its brackets and commas, and bytes their byte
   * count. The figure equals the UTF-8 size for ASCII text and is below it
   * for text outside ASCII. It is not the heap size, which carries a
   * per-object overhead the text does not and shares strings the text
   * repeats.
   */
  bytes: number;

  /** How many values the walk visited, each container and leaf counting one. */
  nodes: number;
};

/** The JSON text taken by a number, taken as fixed rather than written out. */
const NUMBER_LENGTH = 8;

/** The JSON text taken by `null`, `true`, `false` and anything JSON drops. */
const KEYWORD_LENGTH = 4;

/**
 * Measures `value` as {@link ApproximateJsonSize} describes. Plain objects,
 * arrays and class instances are walked through their own enumerable
 * properties; an `ArrayBuffer` or a view onto one counts its byte length and
 * is not walked. The walk expects a tree, as every JSON-derived or
 * codec-encoded value is: a cycle would not end it.
 */
export function approximateJsonSize(value: unknown): ApproximateJsonSize {
  let bytes = 0;
  let nodes = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    nodes++;
    switch (typeof current) {
      case "string":
        bytes += current.length + 2;
        continue;
      case "number":
        bytes += NUMBER_LENGTH;
        continue;
      case "bigint":
        bytes += current.toString().length;
        continue;
      case "object":
        break;
      default:
        bytes += KEYWORD_LENGTH;
        continue;
    }
    if (current === null) {
      bytes += KEYWORD_LENGTH;
    } else if (Array.isArray(current)) {
      bytes += 2 + Math.max(0, current.length - 1);
      for (let index = current.length - 1; index >= 0; index--) {
        stack.push(current[index]);
      }
    } else if (current instanceof ArrayBuffer || ArrayBuffer.isView(current)) {
      bytes += current.byteLength;
    } else {
      bytes += 2;
      let members = 0;
      for (const key in current) {
        if (!Object.hasOwn(current, key)) continue;
        members++;
        bytes += key.length + 3;
        stack.push((current as Record<string, unknown>)[key]);
      }
      bytes += Math.max(0, members - 1);
    }
  }
  return { bytes, nodes };
}
