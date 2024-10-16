/**
 * Simple model for single selection.
 * ProseMirror has its own internal model of selection that is more complex.
 * We use this simple model when passing data into and out of ProseMirror.
 */
export type TextSelection = {
  anchor: number;
  head: number;
  from: number;
  to: number;
};

const freeze = Object.freeze;

export const createSelection = ({ from, to, anchor, head }: TextSelection) =>
  freeze({ from, to, anchor, head });
