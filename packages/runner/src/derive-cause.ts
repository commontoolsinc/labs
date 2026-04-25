import { internSchema } from "@commonfabric/data-model/schema-hash";
import { isRecord } from "@commonfabric/utils/types";
import {
  isPattern,
  type JSONSchema,
  type Module,
  type NodeRef,
  type Pattern,
} from "./builder/types.ts";

export type DeriveCauseSnapshot = {
  frameCause?: unknown;
  connectedNodes: Set<NodeRef<unknown, unknown>> | undefined;
};

const compareKeys = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

const derivedCauseSchemaHash = (schema: JSONSchema): string =>
  internSchema(schema, true).hashString;

const sortRecordEntries = <T extends Record<string, unknown>>(
  value: T,
): T =>
  Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => compareKeys(a, b)),
  ) as T;

const helperForModule = (module: Module | Pattern): string => {
  if (isPattern(module)) {
    return "pattern";
  }

  if (module.wrapper === "handler") {
    return "handler";
  }

  if (module.type === "ref" && typeof module.implementation === "string") {
    return module.implementation;
  }

  return module.type;
};

const implForModule = (module: Module | Pattern) => {
  if (isPattern(module)) {
    return {
      kind: "pattern",
      argumentSchemaHash: derivedCauseSchemaHash(module.argumentSchema),
      resultSchemaHash: derivedCauseSchemaHash(module.resultSchema),
      nodes: module.nodes.length,
    };
  }

  if (typeof module.implementationRef === "string") {
    return module.implementationRef;
  }

  if (typeof module.implementation === "string") {
    return module.implementation;
  }

  if (typeof module.implementation === "function") {
    const fnValue = module.implementation as {
      src?: string;
      name?: string;
      toString(): string;
    };
    return sortRecordEntries({
      source: fnValue.src ?? fnValue.name ?? fnValue.toString(),
    });
  }

  return undefined;
};

const inputsForNode = (inputs: unknown) => {
  if (inputs === undefined) {
    return [];
  }

  if (isRecord(inputs) && !Array.isArray(inputs)) {
    return Object.entries(inputs)
      .sort(([a], [b]) => compareKeys(a, b))
      .map(([, value]) => value);
  }

  const normalized = inputs;
  return Array.isArray(normalized) ? normalized : [normalized];
};

export function deriveCause(
  frameCause: unknown,
  connectedNodes: Set<NodeRef<unknown, unknown>> | undefined,
) {
  const primaryNode = connectedNodes !== undefined
    ? Array.from(connectedNodes)[0]
    : undefined;
  const module = primaryNode?.module;

  const helper = module !== undefined ? helperForModule(module) : undefined;
  const impl = module !== undefined ? implForModule(module) : undefined;
  const inputs = primaryNode !== undefined
    ? inputsForNode(primaryNode.inputs)
    : [];
  const helperIndex = undefined;
  const config = undefined;
  return {
    ...(frameCause !== undefined && { parent: frameCause }),
    ...(helper !== undefined && { helper }),
    ...(impl !== undefined && { impl }),
    ...(inputs !== undefined && { inputs }),
    ...(helperIndex !== undefined && { index: helperIndex }), // need to add helper index (e.g. map index)
    ...(config !== undefined && { config }),
  };
}
