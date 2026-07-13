import type { JSONSchema } from "@commonfabric/api";
import { isRecord } from "@commonfabric/utils/types";

type FrameworkProvidedContract = Readonly<{
  /** Compiler-owned graph metadata; authored asFactory schemas always read []. */
  frameworkProvidedPaths?: readonly (readonly string[])[];
}>;

/**
 * Trusted, compiler-emitted call contract for one dynamic factory node.
 *
 * This is graph metadata, not authored input and not part of Factory@1 state.
 * The runner compares it with the trusted artifact's normalized schemas before
 * any implementation code can run.
 */
export type FactoryContract =
  & FrameworkProvidedContract
  & (
    | Readonly<{
      kind: "pattern";
      argumentSchema: JSONSchema;
      resultSchema: JSONSchema;
    }>
    | Readonly<{
      kind: "module";
      argumentSchema?: JSONSchema;
      resultSchema?: JSONSchema;
    }>
    | Readonly<{
      kind: "handler";
      contextSchema?: JSONSchema;
      eventSchema?: JSONSchema;
    }>
  );

/** Read a schema-declared factory contract without granting authored data. */
export function factoryContractFromSchema(
  schema: JSONSchema | undefined,
): FactoryContract | undefined {
  if (!isRecord(schema) || !("asFactory" in schema)) return undefined;
  const contract = schema.asFactory;
  if (!isRecord(contract)) {
    throw new TypeError("Invalid asFactory schema contract");
  }
  switch (contract.kind) {
    case "pattern":
      return {
        kind: "pattern",
        argumentSchema: contract.argumentSchema as JSONSchema,
        resultSchema: contract.resultSchema as JSONSchema,
        frameworkProvidedPaths: [],
      };
    case "module":
      return {
        kind: "module",
        ...(Object.hasOwn(contract, "argumentSchema")
          ? { argumentSchema: contract.argumentSchema as JSONSchema }
          : {}),
        ...(Object.hasOwn(contract, "resultSchema")
          ? { resultSchema: contract.resultSchema as JSONSchema }
          : {}),
        frameworkProvidedPaths: [],
      };
    case "handler":
      return {
        kind: "handler",
        ...(Object.hasOwn(contract, "contextSchema")
          ? { contextSchema: contract.contextSchema as JSONSchema }
          : {}),
        ...(Object.hasOwn(contract, "eventSchema")
          ? { eventSchema: contract.eventSchema as JSONSchema }
          : {}),
        frameworkProvidedPaths: [],
      };
    default:
      throw new TypeError("Invalid asFactory schema contract kind");
  }
}
