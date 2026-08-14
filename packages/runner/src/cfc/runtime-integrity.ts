import { deepFreeze } from "@commonfabric/data-model/deep-freeze";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { CfcAddress } from "./types.ts";

/**
 * Exact value locations written by an LLM builtin in one transaction.
 *
 * This is a runtime-only channel. The stamp is not represented in schema
 * bytes, so a stored or caller-authored schema cannot cause a later builtin
 * write to mint provenance on unrelated data.
 */
const llmDerivedWrites = new WeakMap<
  IExtendedStorageTransaction,
  CfcAddress[]
>();

/** Record model-output locations whose persisted values carry LLM provenance. */
export const stampLlmDerivedWrites = (
  tx: IExtendedStorageTransaction,
  targets: readonly CfcAddress[],
): void => {
  if (targets.length === 0) return;
  const entries = llmDerivedWrites.get(tx) ?? [];
  for (const target of targets) {
    entries.push(deepFreeze({ ...target, path: [...target.path] }));
  }
  llmDerivedWrites.set(tx, entries);
  tx.markCfcRelevant("llm-derived-write");
};

/** Return the model-output locations recorded for this transaction. */
export const getLlmDerivedWrites = (
  tx: IExtendedStorageTransaction,
): readonly CfcAddress[] => llmDerivedWrites.get(tx) ?? [];
