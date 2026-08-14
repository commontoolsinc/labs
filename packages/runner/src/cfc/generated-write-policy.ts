import type { JSONSchema } from "../builder/types.ts";
import type { Cell } from "../cell.ts";
import type { NormalizedFullLink } from "../link-types.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";

export const recordGeneratedWritePolicyForLink = (
  tx: IExtendedStorageTransaction,
  link: NormalizedFullLink,
  baseSchema: JSONSchema,
  schemaRole: "output" | "setup-output",
): JSONSchema => {
  tx.recordCfcWritePolicyInput({
    kind: "schema",
    target: {
      space: link.space,
      id: link.id,
      scope: link.scope,
      path: [...link.path],
    },
    schema: baseSchema,
    schemaRole,
  });
  return baseSchema;
};

export const recordGeneratedWritePolicy = (
  tx: IExtendedStorageTransaction,
  target: Cell<unknown>,
  baseSchema: JSONSchema,
  schemaRole: "output" | "setup-output" = "output",
): JSONSchema =>
  recordGeneratedWritePolicyForLink(
    tx,
    target.getAsNormalizedFullLink(),
    baseSchema,
    schemaRole,
  );
