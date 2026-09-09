/**
 * What shape a label has to have before anything reads it.
 *
 * Two different readers need this answer and both are on paths where being
 * WRONG is quiet: the sandbox taint reader, where a raised exception leaves a
 * family recorded as it was — which is to say clean — and the family's own
 * persisted record, where a shape nobody checked is seeded as though it were
 * evidence. Neither may end a read by raising, so every function here answers
 * with a boolean for every input, including the inputs a serializer refuses.
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
 * The prototype check is what excludes the exotic ones: a class instance, an
 * object with an inherited `toJSON`, or a `Proxy` over either, all of which
 * can run code when read. `Object.create(null)` is admitted — it carries no
 * inherited anything, which is the property being asked about.
 */
const isInertContainer = (container: object): boolean => {
  const prototype = Object.getPrototypeOf(container);
  if (Array.isArray(container)) {
    return prototype === Array.prototype;
  }
  return prototype === Object.prototype || prototype === null;
};

/**
 * The values of an inert container, read through descriptors so that an
 * accessor property is seen as one rather than invoked. An accessor is not
 * data, so its presence makes the container unreadable.
 */
const inertValues = (container: object): unknown[] => {
  const values: unknown[] = [];
  for (const key of Reflect.ownKeys(container)) {
    const descriptor = Object.getOwnPropertyDescriptor(container, key);
    if (descriptor === undefined || !descriptor.enumerable) {
      continue;
    }
    if (!("value" in descriptor)) {
      // An accessor: reading it would run code.
      return [NOT_DATA];
    }
    values.push(descriptor.value);
  }
  return values;
};

/** Stands for a property that is not data, and so cannot be carried. */
const NOT_DATA = Symbol("cf-harness.not-data");

/**
 * Whether `value` is plain JSON data this can carry: bounded in depth, free
 * of cycles, and holding nothing a serializer would refuse or silently drop.
 *
 * Walked with an explicit stack rather than by recursion, and bounded rather
 * than merely guarded against cycles. Both of those are about the same thing:
 * this must ANSWER for every input. A recursive walk raises `RangeError` on
 * deep input, and an exception raised while reading a container's taint
 * leaves the family recorded as it was — which is to say clean. A shape this
 * cannot read has to come back as `false`.
 *
 * The visited set holds the containers on the CURRENT path, so an object
 * appearing twice in sequence — one atom named in both clauses — is not
 * mistaken for a cycle, which is an object appearing inside itself.
 *
 * Containers are required to be INERT: a plain object or a plain array, read
 * through property descriptors. Reading `Object.values` off an arbitrary
 * object runs whatever getters or proxy traps it carries, and an inherited
 * `toJSON` runs later inside the comparison — either can raise, and a raise
 * here is the failure this exists to prevent. A label that came from
 * `JSON.parse`, which is where every real one comes from, is inert by
 * construction; anything else is a shape this cannot read.
 */
export const isRepresentableJsonValue = (value: unknown): boolean => {
  type Frame = { value: unknown; depth: number; open: boolean };
  const path = new Set<object>();
  const stack: Frame[] = [{ value, depth: 0, open: true }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (!frame.open) {
      path.delete(frame.value as object);
      continue;
    }
    const entry = frame.value;
    if (entry === null) {
      continue;
    }
    switch (typeof entry) {
      case "string":
      case "boolean":
        continue;
      case "number":
        if (!Number.isFinite(entry)) {
          return false;
        }
        continue;
      case "object":
        break;
      default:
        return false;
    }
    const container = entry as object;
    if (
      path.has(container) || frame.depth >= MAX_LABEL_DEPTH ||
      !isInertContainer(container)
    ) {
      return false;
    }
    path.add(container);
    // A closing frame under the children, so the container leaves the current
    // path once everything below it has been read.
    stack.push({ value: container, depth: frame.depth, open: false });
    const children = inertValues(container);
    for (const child of children) {
      if (child !== undefined) {
        stack.push({ value: child, depth: frame.depth + 1, open: true });
      }
    }
  }
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
  if (!isObjectNotArray(value) || !isInertContainer(value)) {
    return undefined;
  }
  const snapshot: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      return undefined;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable) {
      continue;
    }
    if (!("value" in descriptor)) {
      // An accessor on the label itself: reading it would run code, and it
      // could answer differently the next time.
      return undefined;
    }
    const entry = descriptor.value;
    if (key === "confidentiality" || key === "integrity") {
      if (!Array.isArray(entry) || !isRepresentableJsonValue(entry)) {
        return undefined;
      }
      // Deep-copied out of reach of whatever produced it, so nothing that
      // compares or joins this label is reading the original again.
      snapshot[key] = JSON.parse(JSON.stringify(entry));
      continue;
    }
    if (entry !== undefined && entry !== null) {
      return undefined;
    }
  }
  return snapshot;
};
