import type { Module } from "../builder/types.ts";
import type { Harness, HarnessedFunction } from "../harness/types.ts";
import type { ImplementationIdentity } from "./types.ts";
import { hashOf } from "@commonfabric/data-model/value-hash";
import {
  getVerifiedProvenance,
  identityFromCanonicalSource,
} from "../harness/verified-provenance.ts";

export const resolvePolicyFacingImplementationIdentity = (
  module: Module,
  options: {
    verifiedLoadId?: string;
    harness?: Pick<
      Harness,
      | "getVerifiedBindingMetadata"
      | "getVerifiedBundleId"
      | "getVerifiedFunctionInLoad"
      | "isVerifiedSourceInLoad"
    >;
    implementation?: HarnessedFunction;
  } = {},
): ImplementationIdentity | undefined => {
  const debugName = (module as { debugName?: string }).debugName;
  if (typeof debugName === "string" && debugName.startsWith("unsafe-host:")) {
    return undefined;
  }
  if (typeof debugName !== "string" || debugName.length === 0) {
    // Content-addressed provenance needs no load scoping — the function
    // object's registration during verified evaluation IS the proof.
    const provenanceIdentity = resolveProvenanceImplementationIdentity(
      options,
    );
    if (provenanceIdentity) return provenanceIdentity;
    if (
      typeof options.verifiedLoadId !== "string" ||
      options.verifiedLoadId.length === 0
    ) {
      return undefined;
    }
    return resolveVerifiedImplementationIdentity(module, options);
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

const resolveVerifiedImplementationIdentity = (
  module: Module,
  options: {
    verifiedLoadId?: string;
    harness?: Pick<
      Harness,
      | "getVerifiedBindingMetadata"
      | "getVerifiedBundleId"
      | "getVerifiedFunctionInLoad"
      | "isVerifiedSourceInLoad"
    >;
    implementation?: HarnessedFunction;
  },
): ImplementationIdentity => {
  // Legacy path (dual-read until the flip): implementationRef × verifiedLoadId
  // registry checks. The content-addressed provenance path was already tried
  // by the caller (resolvePolicyFacingImplementationIdentity).
  const implementationRef = (module as { implementationRef?: string })
    .implementationRef;
  const { verifiedLoadId, harness, implementation } = options;

  if (
    typeof implementationRef !== "string" ||
    implementationRef.length === 0 ||
    typeof verifiedLoadId !== "string" ||
    verifiedLoadId.length === 0 ||
    !harness ||
    typeof implementation !== "function" ||
    harness.getVerifiedFunctionInLoad?.(verifiedLoadId, implementationRef) !==
      implementation
  ) {
    return {
      kind: "unsupported",
      className: "verified",
      reason:
        "verified compiled policy identity must resolve through the current verified load",
    };
  }

  const bindingMetadata = harness.getVerifiedBindingMetadata?.(
    implementationRef,
  );
  const sourceLocation = parseVerifiedSourceLocation(
    (implementation as { src?: string }).src,
  );
  if (
    !sourceLocation ||
    harness.isVerifiedSourceInLoad?.(verifiedLoadId, sourceLocation.source) !==
      true
  ) {
    return {
      kind: "unsupported",
      className: "verified",
      reason:
        "verified compiled policy identity must map back into the current verified bundle",
    };
  }

  return {
    kind: "verified",
    bundleId: harness.getVerifiedBundleId?.(verifiedLoadId) ?? verifiedLoadId,
    ...(bindingMetadata?.sourceFile
      ? { sourceFile: normalizeIdentitySource(bindingMetadata.sourceFile) }
      : {}),
    ...(bindingMetadata?.bindingPath
      ? { bindingPath: [...bindingMetadata.bindingPath] }
      : {}),
    sourceLocation: {
      line: sourceLocation.line,
      column: sourceLocation.column,
    },
    ...(bindingMetadata?.bindingPath ? {} : {
      codeHash: hashOf(Function.prototype.toString.call(implementation))
        .toString(),
    }),
  };
};

/**
 * Resolve `kind: "verified"` from the function object's content-addressed
 * provenance (see harness/verified-provenance.ts). Returns undefined when the
 * function has no provenance — callers fall back to the legacy registry path.
 *
 * `bundleId` is still attached (from the load's registry) so stored
 * `writeAuthorizedBy` claims written before the moduleIdentity switch keep
 * verifying; new claims are stamped with BOTH (see cfc/prepare.ts).
 */
const resolveProvenanceImplementationIdentity = (
  options: {
    verifiedLoadId?: string;
    harness?: Pick<Harness, "getVerifiedBundleId">;
    implementation?: HarnessedFunction;
  },
): ImplementationIdentity | undefined => {
  const { implementation, verifiedLoadId, harness } = options;
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

  // Mirror the legacy resolver's `getVerifiedBundleId(...) ?? verifiedLoadId`
  // fallback: a stored legacy `writeAuthorizedBy` claim may carry the raw
  // `verifiedLoadId` as its `bundleId` (when the bundle id wasn't registered at
  // stamp time), and the `bundleId` verification arm in cfc/prepare.ts is an
  // exact equality. Dropping the fallback here would leave `bundleId`
  // `undefined` on a `getVerifiedBundleId` miss and fail those legacy claims
  // closed. The `moduleIdentity` arm remains the primary; this only keeps the
  // legacy arm symmetric with the path that produced those claims.
  //
  // Post-flip graphs carry no `implementationRef`, so their rehydrated modules
  // resolve WITHOUT a `verifiedLoadId` — the provenance-recorded bundle id
  // (stamped at evaluation time) then keeps stored bundleId-only claims
  // verifying. Retires with the bundleId arm.
  const bundleId =
    (typeof verifiedLoadId === "string" && verifiedLoadId.length
      ? harness?.getVerifiedBundleId?.(verifiedLoadId) ?? verifiedLoadId
      : undefined) ?? provenance.bundleId;

  return {
    kind: "verified",
    moduleIdentity: provenance.identity,
    ...(provenance.symbol ? { symbol: provenance.symbol } : {}),
    ...(bundleId ? { bundleId } : {}),
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
