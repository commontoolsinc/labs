import type { Module } from "../builder/types.ts";
import type { HarnessedFunction } from "../harness/types.ts";
import type { ImplementationIdentity } from "./types.ts";
import { hashOf } from "@commonfabric/data-model/value-hash";
import {
  getVerifiedProvenance,
  identityFromCanonicalSource,
} from "../harness/verified-provenance.ts";

/**
 * Resolve the policy-facing implementation identity for a module invocation.
 *
 * `kind: "verified"` is proven EXCLUSIVELY by the function object's
 * content-addressed provenance (harness/verified-provenance.ts): an entry
 * exists only for a function registered during a verified evaluation, so the
 * WeakMap lookup itself is the anti-spoof check — an attacker-supplied
 * function (even with byte-identical source text) has no entry and resolves
 * to nothing. The former `implementationRef` × `verifiedLoadId` registry arm
 * is gone (PR E2): every function the legacy registry could admit is an
 * evaluation product and therefore carries provenance, so the arm had no
 * reachable case the provenance path does not cover.
 */
export const resolvePolicyFacingImplementationIdentity = (
  module: Module,
  options: {
    implementation?: HarnessedFunction;
  } = {},
): ImplementationIdentity | undefined => {
  const debugName = (module as { debugName?: string }).debugName;
  if (typeof debugName !== "string" || debugName.length === 0) {
    return resolveProvenanceImplementationIdentity(options.implementation);
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

/**
 * Resolve `kind: "verified"` from the function object's content-addressed
 * provenance. Returns undefined when the function has no provenance —
 * fail-closed: no identity, no authorized write.
 *
 * The provenance yields the content-addressed `moduleIdentity` — the sole
 * `writeAuthorizedBy` verification arm (prepare.ts). The legacy bundleId arm,
 * and the raw `verifiedLoadId` arm before it, retired with the legacy read
 * path (identity E5): a load id embedded a session counter, so such claims
 * could never verify across sessions anyway, and claims written since #4009
 * carry `moduleIdentity`.
 */
const resolveProvenanceImplementationIdentity = (
  implementation: HarnessedFunction | undefined,
): ImplementationIdentity | undefined => {
  if (typeof implementation !== "function") return undefined;
  const provenance = getVerifiedProvenance(implementation);
  if (!provenance) return undefined;

  const src = (implementation as { src?: string }).src;
  const sourceLocation = parseVerifiedSourceLocation(src);
  // Fail closed: the canonical source location must point INTO the provenance
  // module. A mismatch means the src annotation and the registration disagree
  // — treat as unsupported rather than guessing.
  if (
    !sourceLocation ||
    identityFromCanonicalSource(src) !== provenance.identity
  ) {
    return {
      kind: "unsupported",
      className: "verified",
      reason:
        "provenance identity must match the implementation's canonical source",
    };
  }

  return {
    kind: "verified",
    moduleIdentity: provenance.identity,
    ...(provenance.symbol ? { symbol: provenance.symbol } : {}),
    ...(provenance.bindingIdentity
      ? {
        sourceFile: normalizeIdentitySource(
          provenance.bindingIdentity.sourceFile,
        ),
        bindingPath: [...provenance.bindingIdentity.bindingPath],
      }
      : {}),
    sourceLocation: {
      line: sourceLocation.line,
      column: sourceLocation.column,
    },
    ...(provenance.bindingIdentity ? {} : {
      codeHash: hashOf(Function.prototype.toString.call(implementation))
        .toString(),
    }),
  };
};

const parseVerifiedSourceLocation = (
  location: string | undefined,
): { source: string; line: number; column: number } | undefined => {
  if (typeof location !== "string" || location.length === 0) {
    return undefined;
  }

  const match = /^(.*):(\d+):(\d+)$/.exec(location);
  if (!match) {
    return undefined;
  }

  const [, source, line, column] = match;
  return {
    source: normalizeIdentitySource(source),
    line: Number.parseInt(line, 10),
    column: Number.parseInt(column, 10),
  };
};

const normalizeIdentitySource = (source: string): string =>
  source.startsWith("/") ? source : `/${source}`;
