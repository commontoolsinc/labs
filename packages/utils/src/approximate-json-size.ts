/**
 * A cheap measure of how much a value would weigh as JSON text, for a
 * diagnostic that wants to rank values by size without encoding them. The
 * walk allocates nothing beyond its own stack, and that stack holds only the
 * containers still to visit, so a value measured here leaves the heap as it
 * found it, which is what makes it safe to run inside a process that is
 * already short of memory.
 */

/** What a walk measured. */
export type ApproximateJsonSize = {
  /**
   * The approximate length of the value's JSON text, in UTF-16 code units:
   * a string its length and quotes, a number eight, a bigint twenty, a
   * keyword its letters, a key its length, quotes and colon, a container its
   * brackets and commas, and bytes their byte count. The figure equals the
   * UTF-8 size for ASCII text and is below it for text outside ASCII. It is
   * not the heap size, which carries a per-object overhead the text does not
   * and shares strings the text repeats.
   */
  bytes: number;

  /** How many values the walk visited, each container and leaf counting one. */
  nodes: number;

  /**
   * Whether the walk visited the whole value. `false` once it reached the
   * caller's `nodeLimit`, when `bytes` counts what it visited and no more:
   * a lower bound on the value's size.
   */
  complete: boolean;
};

/** What a caller may hand the walk. */
export type ApproximateJsonSizeOptions = {
  /**
   * The size of an object that is neither an array nor a byte buffer, for a
   * caller whose values hold instances that keep their payload private, as
   * the Fabric primitives do: `undefined` to have the instance walked
   * through its own enumerable properties like any object.
   */
  instanceSize?: (instance: object) => number | undefined;

  /**
   * The most nodes the walk may visit before it stops and reports itself
   * incomplete, for a caller measuring within a budget. Unbounded when
   * absent.
   */
  nodeLimit?: number;
};

/** The JSON text taken by a number, taken as fixed rather than written out. */
const NUMBER_LENGTH = 8;

/** The JSON text taken by a bigint, taken as fixed rather than written out. */
const BIGINT_LENGTH = 20;

/** The JSON text taken by `null`, `true` and anything JSON drops. */
const KEYWORD_LENGTH = 4;

/** The JSON text taken by `false`. */
const FALSE_LENGTH = 5;

/**
 * Measures `value` as {@link ApproximateJsonSize} describes. Plain objects,
 * arrays and class instances are walked through their own enumerable
 * properties, an instance first offered to `options.instanceSize`; an
 * `ArrayBuffer` or a view onto one counts its byte length and is not
 * walked. The walk expects a tree, as every JSON-derived or codec-encoded
 * value is: a cycle would not end it short of `options.nodeLimit`. A sparse
 * array costs its length in time, as its JSON would, and nothing in memory,
 * since a leaf is counted where it is found and never queued.
 */
export function approximateJsonSize(
  value: unknown,
  options: ApproximateJsonSizeOptions = {},
): ApproximateJsonSize {
  const { instanceSize, nodeLimit = Infinity } = options;
  let bytes = 0;
  let nodes = 0;
  const containers: object[] = [];

  /** Counts one value, queuing it when it is a container to walk. */
  const visit = (current: unknown): void => {
    nodes++;
    switch (typeof current) {
      case "string":
        bytes += current.length + 2;
        return;
      case "number":
        bytes += NUMBER_LENGTH;
        return;
      case "bigint":
        bytes += BIGINT_LENGTH;
        return;
      case "boolean":
        bytes += current ? KEYWORD_LENGTH : FALSE_LENGTH;
        return;
      case "object":
        if (current === null) {
          bytes += KEYWORD_LENGTH;
        } else if (
          current instanceof ArrayBuffer || ArrayBuffer.isView(current)
        ) {
          bytes += current.byteLength;
        } else {
          containers.push(current);
        }
        return;
      default:
        bytes += KEYWORD_LENGTH;
    }
  };

  visit(value);
  // Cut short at the limit only where a child is about to be visited, so a
  // container with nothing left in it never counts as cutting the walk.
  let complete = true;
  while (containers.length > 0 && complete) {
    const current = containers.pop()!;
    if (Array.isArray(current)) {
      bytes += 2 + Math.max(0, current.length - 1);
      for (let index = 0; index < current.length; index++) {
        if (nodes >= nodeLimit) {
          complete = false;
          break;
        }
        visit(current[index]);
      }
      continue;
    }
    const size = instanceSize?.(current);
    if (size !== undefined) {
      bytes += size;
      continue;
    }
    bytes += 2;
    let members = 0;
    for (const key in current) {
      if (!Object.hasOwn(current, key)) continue;
      if (nodes >= nodeLimit) {
        complete = false;
        break;
      }
      members++;
      bytes += key.length + 3;
      visit((current as Record<string, unknown>)[key]);
    }
    bytes += Math.max(0, members - 1);
  }
  return { bytes, nodes, complete };
}
