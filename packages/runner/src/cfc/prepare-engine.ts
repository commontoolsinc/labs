import type { JSONSchema } from "../builder/types.ts";
import type {
  ICfcPrepareSchemaUnavailableError,
  ICfcSchemaHashMismatchError,
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
} from "../storage/interface.ts";
import { computeCfcActivityDigest } from "./activity-digest.ts";
import { canonicalizeBoundaryActivity } from "./canonical-activity.ts";
import { internalVerifierReadMeta } from "./internal-markers.ts";
import { getCfcWriteSchemaContext } from "./schema-context.ts";
import { computeCfcSchemaHash } from "./schema-hash.ts";

type EntityAddress = Pick<IMemorySpaceAddress, "space" | "id" | "type">;

function entityKey(entity: EntityAddress): string {
  return `${entity.space}\u0000${entity.id}\u0000${entity.type}`;
}

function CfcPrepareSchemaUnavailableError(
  entity: EntityAddress,
): ICfcPrepareSchemaUnavailableError {
  return {
    name: "CfcPrepareSchemaUnavailableError",
    message:
      "CFC prepare could not resolve schema for commit-bearing relevant write",
    space: entity.space,
    id: entity.id,
    type: entity.type,
  };
}

function CfcSchemaHashMismatchError(
  entity: EntityAddress,
  expectedSchemaHash: string,
  actualSchemaHash: string,
): ICfcSchemaHashMismatchError {
  return {
    name: "CfcSchemaHashMismatchError",
    message: "CFC prepare found existing schema hash that does not match",
    expectedSchemaHash,
    actualSchemaHash,
    space: entity.space,
    id: entity.id,
    type: entity.type,
  };
}

function collectWrittenEntities(
  tx: IExtendedStorageTransaction,
): EntityAddress[] {
  const canonical = canonicalizeBoundaryActivity(tx.journal.activity());
  const entities = new Map<string, EntityAddress>();
  for (const write of canonical.attemptedWrites) {
    const entity: EntityAddress = {
      space: write.space as IMemorySpaceAddress["space"],
      id: write.id as IMemorySpaceAddress["id"],
      type: write.type as IMemorySpaceAddress["type"],
    };
    entities.set(entityKey(entity), entity);
  }
  return [...entities.values()];
}

async function resolvePreparedSchemaHash(
  schema: JSONSchema,
): Promise<string> {
  return await computeCfcSchemaHash(schema);
}

function schemaHashAddress(entity: EntityAddress): IMemorySpaceAddress {
  return {
    space: entity.space,
    id: entity.id,
    type: entity.type,
    path: ["cfc", "schemaHash"],
  };
}

export async function prepareBoundaryCommit(
  tx: IExtendedStorageTransaction,
): Promise<void> {
  const writtenEntities = collectWrittenEntities(tx);
  const hasIfcWriteReason = tx.cfcReasons.includes("ifc-write-schema");
  let enforcedSchemaHashCount = 0;

  if (hasIfcWriteReason) {
    for (const entity of writtenEntities) {
      const schema = getCfcWriteSchemaContext(tx, {
        ...entity,
        path: [],
      });
      if (!schema) {
        continue;
      }
      enforcedSchemaHashCount++;

      const actualSchemaHash = await resolvePreparedSchemaHash(schema);
      const address = schemaHashAddress(entity);
      const existingSchemaHash = tx.readOrThrow(address, {
        meta: internalVerifierReadMeta,
      });

      if (existingSchemaHash === undefined) {
        tx.writeOrThrow(address, actualSchemaHash);
        continue;
      }

      if (
        typeof existingSchemaHash !== "string" ||
        existingSchemaHash !== actualSchemaHash
      ) {
        throw CfcSchemaHashMismatchError(
          entity,
          String(existingSchemaHash),
          actualSchemaHash,
        );
      }
    }

    if (writtenEntities.length > 0 && enforcedSchemaHashCount === 0) {
      throw CfcPrepareSchemaUnavailableError(writtenEntities[0]);
    }
  }

  const digest = await computeCfcActivityDigest(tx.journal.activity());
  tx.markCfcPrepared(digest);
}
