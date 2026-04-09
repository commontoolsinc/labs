import type { Module } from "../builder/types.ts";
import type { Harness, HarnessedFunction } from "../harness/types.ts";
import type { ImplementationIdentity } from "./types.ts";
import { hashOf } from "@commonfabric/data-model/value-hash";

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
