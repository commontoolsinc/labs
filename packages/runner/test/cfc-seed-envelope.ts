import { internSchemaAsTaggedHashString } from "@commonfabric/data-model/schema-hash";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import type { JSONSchema } from "../src/builder/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

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
