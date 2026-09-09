/**
 * What shape a label has to have before anything reads it.
 *
 * Two different readers need this answer and both are on paths where being
 * WRONG is quiet: the sandbox taint reader, where a raised exception leaves a
 * run recorded as it was — which is to say clean — and the run's own
 * persisted record, where a shape nobody checked is seeded as though it were
 * evidence. Neither may end a read by raising, so every function here answers
 * for every input, including the inputs a serializer refuses: with the data
 * it was able to take, or with nothing at all.
 */

import { isObjectNotArray } from "@commonfabric/utils/types";

/**
 * How deep a label's own data may nest.
 *
 * A CFC label is a list of atoms, and an atom is a small flat record; nothing
 * this reads has any use for depth. The bound is what keeps BOTH walks over
 * one finite: this one, and the serializer that compares two labels
 * afterwards. A structure deeper than this is not something the format
 * describes, so refusing it costs nothing real and removes the last way a
 * label can end a read by raising instead of answering.
 */
export const MAX_LABEL_DEPTH = 64;

/**
 * Whether `container` is a plain object or plain array and nothing more.
 *
 * The prototype check excludes the ones carrying inherited behavior a read
 * would run: a class instance, an object with an inherited `toJSON`.
 * `Object.create(null)` is admitted — it carries no inherited anything, which
 * is the property being asked about.
 *
 * It does not exclude a `Proxy`, and is not asked to: a proxy reports its
 * target's prototype, so no check made of one distinguishes it. What answers
 * a proxy is the reading below rather than a heuristic here — every value is
 * taken once, through a descriptor, so a trap that answers differently the
 * second time has nothing left to answer, and a trap that raises refuses the
 * label instead of escaping.
 */
const isInertContainer = (container: object): boolean => {
  const prototype = Object.getPrototypeOf(container);
  if (Array.isArray(container)) {
    return prototype === Array.prototype;
  }
  return prototype === Object.prototype || prototype === null;
};

/**
 * The own enumerable DATA entries of a container, read once.
 *
 * Read once is the point. Every later step uses what this returned, so a
 * source that answers differently the second time — a proxy whose `length`
 * or `ownKeys` changes between reads — cannot change what was copied. An
 * accessor is not data: reading it would run code, so its presence makes the
 * container unreadable rather than being invoked.
 */
const inertEntries = (
  container: object,
  recognized?: ReadonlySet<string>,
): readonly (readonly [string, unknown])[] | undefined => {
  const entries: (readonly [string, unknown])[] = [];
  for (const key of Reflect.ownKeys(container)) {
    if (typeof key !== "string") {
      return undefined;
    }
    const descriptor = Object.getOwnPropertyDescriptor(container, key);
    if (descriptor === undefined) {
      continue;
    }
    if (!descriptor.enumerable) {
      // A key this build reads MEANING from, hidden where a walk over own
      // enumerable properties does not go. Skipping it would answer with a
      // label carrying less than the source does, which is the fail-open this
      // exists to prevent: it is a shape this cannot read, not a label with
      // one fewer requirement.
      if (recognized?.has(key)) {
        return undefined;
      }
      continue;
    }
    if (!("value" in descriptor)) {
      return undefined;
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
};

/** The keys a label carries meaning in. */
const LABEL_CLAUSES: ReadonlySet<string> = new Set([
  "confidentiality",
  "integrity",
]);

/** A primitive this can carry, or `undefined` when it is not one. */
const inertPrimitive = (
  value: unknown,
): { readonly value: unknown } | undefined => {
  if (value === null) {
    return { value: null };
  }
  switch (typeof value) {
    case "string":
    case "boolean":
      return { value };
    case "number":
      return Number.isFinite(value) ? { value } : undefined;
    default:
      return undefined;
  }
};

/**
 * A copy of `value` as plain data, or `undefined` when it is not plain data.
 *
 * COPIED as it is walked, rather than validated and then serialized. A
 * verdict about mutable input is only true of the read that produced it: a
 * proxy can pass validation and answer differently when the value is later
 * compared or cloned, and serializing the SOURCE afterwards reads it again.
 * Every primitive here is written into a fresh array or object during the
 * same descriptor walk that checked it, and nothing downstream touches the
 * original.
 *
 * Iterative, with a visited set for cycles and a depth bound. Both are about
 * answering for every input: recursion raises `RangeError` on deep data, and
 * a raise while reading a container's taint leaves a run recorded as clean.
 */
const inertJsonCopy = (
  root: object,
  depth: number,
): { readonly value: unknown } | undefined => {
  type Frame = {
    readonly entries: readonly (readonly [string, unknown])[];
    readonly target: Record<string, unknown> | unknown[];
    readonly source: object;
    readonly depth: number;
    index: number;
  };
  const open = new Set<object>();
  const frameFor = (container: object, atDepth: number): Frame | undefined => {
    if (open.has(container) || atDepth >= MAX_LABEL_DEPTH) {
      return undefined;
    }
    if (!isInertContainer(container)) {
      return undefined;
    }
    const entries = inertEntries(container);
    if (entries === undefined) {
      return undefined;
    }
    open.add(container);
    return {
      entries,
      target: Array.isArray(container) ? [] : {},
      source: container,
      depth: atDepth,
      index: 0,
    };
  };
  const first = frameFor(root, depth);
  if (first === undefined) {
    return undefined;
  }
  const stack: Frame[] = [first];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.index >= frame.entries.length) {
      open.delete(frame.source);
      stack.pop();
      continue;
    }
    const [key, entry] = frame.entries[frame.index];
    frame.index += 1;
    const asPrimitive = inertPrimitive(entry);
    if (asPrimitive !== undefined) {
      if (!assign(frame.target, key, asPrimitive.value)) {
        return undefined;
      }
      continue;
    }
    if (typeof entry !== "object" || entry === null) {
      return undefined;
    }
    const child = frameFor(entry as object, frame.depth + 1);
    if (child === undefined || !assign(frame.target, key, child.target)) {
      return undefined;
    }
    stack.push(child);
  }
  return { value: first.target };
};

/**
 * Writes one entry into the copy, or reports that it cannot be written.
 *
 * An array's own enumerable data keys are its indices. Anything else on one —
 * a named property hung off a list of atoms — is data the copy has nowhere to
 * put, and dropping it would answer with a value that says less than the
 * source. That is the same fail-open as a hidden clause, so it is refused
 * rather than skipped.
 */
const assign = (
  target: Record<string, unknown> | unknown[],
  key: string,
  value: unknown,
): boolean => {
  if (Array.isArray(target)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || String(index) !== key) {
      return false;
    }
    target[index] = value;
    return true;
  }
  target[key] = value;
  return true;
};

/**
 * Whether `value` is an IFC label this can represent: clauses that are lists
 * of data this can carry, and nothing else carrying content. A label whose
 * `confidentiality` is a string survives an equality comparison and is then
 * dropped by the merge, leaving a family that carried a requirement recorded
 * as carrying none — and one holding a cycle anywhere inside it would throw
 * out of the comparison instead.
 */
export const isRepresentableIfcLabel = (value: unknown): boolean =>
  inertLabelSnapshot(value) !== undefined;

/**
 * The label as inert plain data, or `undefined` when it is not one.
 *
 * A SNAPSHOT rather than a verdict, because a verdict about mutable input is
 * only true of the read that produced it. An accessor on the label's own
 * `confidentiality` property can answer one thing while being validated and
 * another while being compared; a proxy can pass three reads and throw on the
 * fourth. Taking the data out once, through descriptors, and using only the
 * copy afterwards is what makes the later comparison and join describe the
 * same label the check passed.
 *
 * The root object is read the same way as everything under it — through
 * descriptors, off an inert container — because the root is where the label's
 * own clauses live and an accessor there is the one a walk that starts below
 * it never sees.
 */
export const inertLabelSnapshot = (
  value: unknown,
): Record<string, unknown> | undefined => {
  try {
    return readInertLabel(value);
  } catch {
    // A proxy can trap the reads this makes to decide whether it is inert —
    // `ownKeys` and `getOwnPropertyDescriptor` among them — so the decision
    // itself can raise. Answering `undefined` is what makes this total: every
    // caller treats a label it cannot read as one that establishes nothing,
    // and none can afford an exception instead.
    return undefined;
  }
};

const readInertLabel = (
  value: unknown,
): Record<string, unknown> | undefined => {
  if (!isObjectNotArray(value) || !isInertContainer(value)) {
    return undefined;
  }
  const entries = inertEntries(value, LABEL_CLAUSES);
  if (entries === undefined) {
    // An accessor on the label itself: reading it would run code, and it
    // could answer differently the next time.
    return undefined;
  }
  const snapshot: Record<string, unknown> = {};
  for (const [key, entry] of entries) {
    if (key === "confidentiality" || key === "integrity") {
      if (!Array.isArray(entry)) {
        return undefined;
      }
      const copied = inertJsonCopy(entry, 0);
      if (copied === undefined || !Array.isArray(copied.value)) {
        return undefined;
      }
      snapshot[key] = copied.value;
      continue;
    }
    if (entry !== undefined && entry !== null) {
      return undefined;
    }
  }
  return snapshot;
};
