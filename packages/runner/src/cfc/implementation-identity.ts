import type { Module } from "../builder/types.ts";
import type { ImplementationIdentity } from "./types.ts";

export const resolveBuiltinImplementationIdentity = (
  module: Module,
): ImplementationIdentity | undefined => {
  const debugName = (module as { debugName?: string }).debugName;
  if (typeof debugName !== "string" || debugName.length === 0) {
    return undefined;
  }

  return {
    kind: "builtin",
    builtinId: debugName,
  };
};
