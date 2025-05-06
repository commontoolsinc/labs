/** Cancel functions are zero-argument functions that perform cleanup */
export type Cancel = () => void;

export type AddCancel = (cancel: Cancel | undefined | null) => void;

/** Is value a cancel function? */
export const isCancel = (value: unknown): value is Cancel => {
  return typeof value === "function" && value.length === 0;
};

/** A cancellable is a type that may have a cancel property */
export type Cancellable = {
  cancel?: Cancel;
};

/** Cancel a cancellable */
export const cancel = (cancellable: Cancellable) => {
  cancellable.cancel?.();
};

/**
 * Create a cancel function that can gather and manage other
 * cancel functions.
 * @returns a pair of cancel function and a function to add cancel to group.
 * @example
 * const [cancel, addCancel] = useCancelGroup();
 * addCancel(cancel1);
 * addCancel(cancel2);
 * cancel(); // Cancels all in group
 */
export const useCancelGroup = (): [Cancel, AddCancel] => {
  const cancels = new Set<Cancel>();

  /** Cancel all cancel functions in the group */
  const cancelAll = () => {
    for (const cancel of cancels) {
      cancel();
    }
    cancels.clear();
  };

  /** Add a cancel function to the group */
  const addCancel = (cancel: Cancel | undefined | null) => {
    if (cancel == null) {
      return;
    }
    cancels.add(cancel);
  };

  return [cancelAll, addCancel];
};

export const noOp = () => {};
