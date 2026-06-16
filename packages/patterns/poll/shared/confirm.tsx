import { type Writable } from "commonfabric";

export type TargetConfirmCell = Writable<string | null>;
export type FlagConfirmCell = Writable<boolean>;

export const isTargetConfirming = (
  pendingTarget: string | null | undefined,
  target: string,
) => pendingTarget === target;

export const isFlagConfirming = (pending: boolean | undefined) =>
  pending === true;

export const requestTargetConfirm = (
  confirmTarget: TargetConfirmCell,
  target: string,
) => confirmTarget.set(target);

export const clearTargetConfirm = (confirmTarget: TargetConfirmCell) =>
  confirmTarget.set(null);

export const revealFlagConfirm = (confirmFlag: FlagConfirmCell) =>
  confirmFlag.set(true);

export const clearFlagConfirm = (confirmFlag: FlagConfirmCell) =>
  confirmFlag.set(false);
