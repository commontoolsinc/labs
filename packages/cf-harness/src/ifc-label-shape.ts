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
    if (path.has(container) || frame.depth >= MAX_LABEL_DEPTH) {
      return false;
    }
    path.add(container);
    // A closing frame under the children, so the container leaves the current
    // path once everything below it has been read.
    stack.push({ value: container, depth: frame.depth, open: false });
    const children = Array.isArray(container)
      ? container
      : Object.values(container);
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
export const isRepresentableIfcLabel = (value: unknown): boolean => {
  if (!isObjectNotArray(value)) {
    return false;
  }
  return Object.entries(value).every(([clause, entry]) =>
    (clause === "confidentiality" || clause === "integrity")
      ? Array.isArray(entry) && isRepresentableJsonValue(entry)
      : entry === undefined || entry === null
  );
};
