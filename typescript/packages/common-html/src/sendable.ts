import { isObject } from "./util.js";

/** A sendable is a type with a send method */
export type Sendable<T> = {
  send: (value: T) => void
}

export const isSendable = (
  value: unknown
): value is Sendable<unknown> => {
  return isObject(value) && "send" in value && typeof value.send === "function";
}