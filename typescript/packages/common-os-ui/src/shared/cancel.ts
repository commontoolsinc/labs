export type Cancel = () => void;

export const createCancelGroup = () => {
  const cancels: Set<Cancel> = new Set();

  const cancel = () => {
    for (const cancel of cancels) {
      cancel();
    }
    cancels.clear();
  };

  cancel.add = (cancel: Cancel) => {
    cancels.add(cancel);
  };

  return cancel;
};
