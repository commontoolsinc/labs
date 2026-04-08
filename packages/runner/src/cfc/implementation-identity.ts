import type { Module } from "../builder/types.ts";
import type { ImplementationIdentity } from "./types.ts";

export const resolvePolicyFacingImplementationIdentity = (
  module: Module,
  options: { verifiedLoadId?: string } = {},
): ImplementationIdentity | undefined => {
  const debugName = (module as { debugName?: string }).debugName;
  if (typeof debugName !== "string" || debugName.length === 0) {
    if (typeof options.verifiedLoadId !== "string" ||
      options.verifiedLoadId.length === 0) {
      return undefined;
    }
    return {
      kind: "unsupported",
      className: "verified",
      reason:
        "verified compiled policy identity is blocked until the richer bundle/path/location/hash identity lands",
    };
  }

  return {
    kind: "builtin",
    builtinId: debugName,
  };
};

export const resolveBuiltinImplementationIdentity = (
  module: Module,
): ImplementationIdentity | undefined =>
  resolvePolicyFacingImplementationIdentity(module);
