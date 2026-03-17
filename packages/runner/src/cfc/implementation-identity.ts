import { canonicalHash } from "@commontools/memory/canonical-hash";
import { storableFromNativeValue } from "@commontools/memory/storable-value";
import type { JSONSchema, Module, Pattern } from "../builder/types.ts";
import { toHex } from "./shared.ts";

const cfcBuiltinModuleNameMarker = Symbol("cfcBuiltinModuleName");

type BuiltinModule = Module & {
  [cfcBuiltinModuleNameMarker]?: string;
};

export type CfcImplementationIdentity =
  | {
    readonly kind: "builtin";
    readonly name: string;
  }
  | {
    readonly kind: "codeHash";
    readonly hash: string;
  }
  | {
    readonly kind: "unknown";
  };

export interface CfcImplementationIdentityAnnotated {
  readonly cfcImplementationIdentity?: CfcImplementationIdentity;
}

export function unknownImplementationIdentity(): CfcImplementationIdentity {
  return { kind: "unknown" };
}

export function builtinImplementationIdentity(
  name: string,
): CfcImplementationIdentity {
  return { kind: "builtin", name };
}

export function codeHashImplementationIdentity(
  hash: string,
): CfcImplementationIdentity {
  return { kind: "codeHash", hash };
}

export function encodeImplementationIdentity(
  identity: CfcImplementationIdentity | undefined,
): string {
  if (!identity || identity.kind === "unknown") {
    return "Unknown";
  }
  if (identity.kind === "builtin") {
    return `Builtin(${identity.name})`;
  }
  return `CodeHash(${identity.hash})`;
}

export function getAnnotatedImplementationIdentity(
  annotated: unknown,
): CfcImplementationIdentity | undefined {
  if (
    !annotated ||
    (typeof annotated !== "object" && typeof annotated !== "function")
  ) {
    return undefined;
  }
  return (annotated as CfcImplementationIdentityAnnotated)
    .cfcImplementationIdentity;
}

export function encodeAnnotatedImplementationIdentity(
  annotated: unknown,
): string {
  return encodeImplementationIdentity(
    getAnnotatedImplementationIdentity(annotated),
  );
}

export function markBuiltinModule(
  module: Module,
  name: string,
): Module {
  Object.defineProperty(module as BuiltinModule, cfcBuiltinModuleNameMarker, {
    value: name,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  return module;
}

export function getBuiltinModuleName(module: Module): string | undefined {
  const name = (module as BuiltinModule)[cfcBuiltinModuleNameMarker];
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

function normalizeSchema(schema: JSONSchema | undefined): unknown {
  return schema ?? null;
}

function normalizePattern(pattern: Pattern): unknown {
  return {
    argumentSchema: normalizeSchema(pattern.argumentSchema),
    resultSchema: normalizeSchema(pattern.resultSchema),
    initial: pattern.initial ?? null,
    result: pattern.result ?? null,
    nodes: pattern.nodes.map((node) => ({
      description: node.description ?? null,
      inputs: node.inputs ?? null,
      outputs: node.outputs ?? null,
      module: normalizeModuleDescriptor(node.module as Module),
    })),
  };
}

function normalizeImplementationDescriptor(
  implementation: Module["implementation"],
): unknown {
  if (typeof implementation === "function") {
    return {
      kind: "function",
      source: implementation.toString(),
      name: implementation.name ?? "",
      src: (implementation as { src?: unknown }).src ?? null,
    };
  }
  if (typeof implementation === "string") {
    return {
      kind: "ref",
      value: implementation,
    };
  }
  if (implementation && typeof implementation === "object") {
    return {
      kind: "pattern",
      value: normalizePattern(implementation as Pattern),
    };
  }
  return {
    kind: "unknown",
    value: implementation ?? null,
  };
}

function normalizeModuleDescriptor(module: Module): unknown {
  return {
    type: module.type,
    wrapper: module.wrapper ?? null,
    isEffect: module.isEffect === true,
    argumentSchema: normalizeSchema(module.argumentSchema),
    resultSchema: normalizeSchema(module.resultSchema),
    implementation: normalizeImplementationDescriptor(module.implementation),
  };
}

export function computeModuleCodeHash(module: Module): string {
  const storable = storableFromNativeValue(normalizeModuleDescriptor(module));
  return toHex(canonicalHash(storable).hash);
}

export function deriveImplementationIdentity(
  module: Module | undefined,
): CfcImplementationIdentity {
  if (!module) {
    return unknownImplementationIdentity();
  }

  const builtinName = getBuiltinModuleName(module);
  if (builtinName) {
    return builtinImplementationIdentity(builtinName);
  }

  return codeHashImplementationIdentity(computeModuleCodeHash(module));
}
