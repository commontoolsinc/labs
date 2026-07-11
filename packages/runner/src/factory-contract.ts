import type { JSONSchema } from "@commonfabric/api";
import { isRecord } from "@commonfabric/utils/types";

/**
 * Trusted, compiler-emitted call contract for one dynamic factory node.
 *
 * This is graph metadata, not authored input and not part of Factory@1 state.
 * The runner compares it with the trusted artifact's normalized schemas before
 * any implementation code can run.
 */
export type FactoryContract =
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
  }>;

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
    case "module":
    case "handler":
      return contract as FactoryContract;
    default:
      throw new TypeError("Invalid asFactory schema contract kind");
  }
}
