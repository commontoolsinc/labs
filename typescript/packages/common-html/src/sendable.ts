export type Sendable<T> = {
  send: (value: T) => void;
};

export const isSendable = (
  value: unknown
): value is Sendable<unknown> => {
  return typeof (value as Sendable<unknown>)?.send === "function";
}