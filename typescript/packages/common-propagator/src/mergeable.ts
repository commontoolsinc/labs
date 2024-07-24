/** A mergeable is a type that knows how to merge itself with itself */
export interface Mergeable {
  merge(value: this): this;
}

export const isMergeable = (value: any): value is Mergeable => {
  return (
    typeof value === "object" &&
    typeof value.merge === "function" &&
    value.merge.length === 1
  );
};

/**
 * Merge will merge prev and curr if they are mergeable, otherwise will
 * return curr.
 */
export const merge = <T>(prev: T, curr: T): T => {
  if (isMergeable(prev) && isMergeable(curr)) {
    return prev.merge(curr);
  }
  return curr;
};
