import type { JSONSchema } from "../builder/types.ts";
import type {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
  IStorageTransaction,
} from "../storage/interface.ts";
import { cfcEntityKey } from "./shared.ts";

type SchemaContextEntry = {
  schema: JSONSchema;
  pathLength: number;
};

const schemaContextByTx = new WeakMap<
  IStorageTransaction,
  Map<string, SchemaContextEntry>
>();

function getOrCreateTxSchemaContext(
  tx: IExtendedStorageTransaction,
): Map<string, SchemaContextEntry> {
  let context = schemaContextByTx.get(tx.tx);
  if (!context) {
    context = new Map();
    schemaContextByTx.set(tx.tx, context);
  }
  return context;
}

export function recordCfcWriteSchemaContext(
  tx: IExtendedStorageTransaction,
  address: IMemorySpaceAddress,
  schema: JSONSchema | undefined,
): void {
  if (schema === undefined) {
    return;
  }

  const context = getOrCreateTxSchemaContext(tx);
  const key = cfcEntityKey(address);
  const existing = context.get(key);
  const pathLength = address.path.length;

  // Keep the shortest-path schema we saw for this entity in the attempt.
  if (!existing || pathLength < existing.pathLength) {
    context.set(key, { schema, pathLength });
  }
}

export function getCfcWriteSchemaContext(
  tx: IExtendedStorageTransaction,
  address: IMemorySpaceAddress,
): JSONSchema | undefined {
  const context = schemaContextByTx.get(tx.tx);
  const key = cfcEntityKey(address);
  return context?.get(key)?.schema;
}
