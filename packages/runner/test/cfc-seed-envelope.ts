import { internSchemaAsTaggedHashString } from "@commonfabric/data-model-schema";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import type { JSONSchema } from "../src/builder/types.ts";
import type {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
  IWriteOptions,
} from "../src/storage/interface.ts";
import type { FabricValue } from "@commonfabric/data-model";
import type { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";

/**
 * The schema document CFC-metadata SEEDS reference. The commit boundary
 * validates a metadata `schemaHash` like any other schema reference —
 * backed by a verifying document or refused — so a fixture that seeds
 * stored label state names this real document and installs it in the
 * same transaction with {@link writeSeedEnvelopeDoc}.
 */
export const SEED_ENVELOPE_SCHEMA = {
  type: "object",
  title: "cfc-test-seed-envelope",
} as const satisfies JSONSchema;

export const SEED_ENVELOPE_SCHEMA_HASH: string = internSchemaAsTaggedHashString(
  SEED_ENVELOPE_SCHEMA,
);

/** Installs the seed envelope document so the seeding commit verifies. */
export const writeSeedEnvelopeDoc = (
  tx: IExtendedStorageTransaction,
  space: MemorySpace,
): void => {
  tx.writeOrThrow({
    space,
    scope: "space",
    id: `cid:${SEED_ENVELOPE_SCHEMA_HASH}` as URI,
    path: [],
  }, { value: SEED_ENVELOPE_SCHEMA });
};

/**
 * Writes a stored document envelope with the runtime's own authority.
 *
 * A document's reserved siblings — the `cfc` label map and `source` — are the
 * runtime's to write, and the write chokepoint records any other writer that
 * changes one. A fixture stands outside the runtime and still needs stored
 * label state, in shapes the derivation pass does not produce: a forged atom,
 * a version this build cannot read, a record carrying no label map. This runs
 * the write inside the privileged persistence scope, the same scope
 * `prepareBoundaryCommit()` lands a derived label map in, so the seed is not
 * recorded as the forgery it resembles.
 */
export const seedStoredEnvelope = (
  tx: IExtendedStorageTransaction,
  address: IMemorySpaceAddress,
  value: FabricValue,
  options?: IWriteOptions,
): void => {
  (tx as ExtendedStorageTransaction).accessForTestingOnly
    .privilegedSystemWrite(address, value, options);
};
