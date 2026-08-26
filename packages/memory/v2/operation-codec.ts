import { rebaseUpdates, type Update } from "@codemirror/collab";
import { ChangeSet, Text } from "@codemirror/state";
import type { FabricValue } from "@commonfabric/api";
import { hashStringOf } from "@commonfabric/data-model/value-hash";
import { CODEMIRROR_CHANGESET_CODEC, encodeMemoryBoundary } from "../v2.ts";

export { CODEMIRROR_CHANGESET_CODEC } from "../v2.ts";

export type OperationCodecInput = {
  materialized: FabricValue;
  submitted: FabricValue;
  intervening: readonly FabricValue[];
};

export type OperationCodecResult = {
  materialized: FabricValue;
  operations: FabricValue[];
};

export type OperationCodec = {
  readonly id: string;
  integrate(input: OperationCodecInput): OperationCodecResult;
};

export class OperationCodecRegistry {
  readonly #codecs = new Map<string, OperationCodec>();

  constructor(codecs: readonly OperationCodec[] = []) {
    for (const codec of codecs) this.register(codec);
  }

  register(codec: OperationCodec): void {
    if (!/@[1-9][0-9]*$/.test(codec.id)) {
      throw new Error(
        `operation codec id requires a version suffix: ${codec.id}`,
      );
    }
    if (this.#codecs.has(codec.id)) {
      throw new Error(`operation codec already registered: ${codec.id}`);
    }
    this.#codecs.set(codec.id, codec);
  }

  require(id: string): OperationCodec {
    const codec = this.#codecs.get(id);
    if (!codec) throw new Error(`unknown operation codec: ${id}`);
    return codec;
  }

  ids(): string[] {
    return [...this.#codecs.keys()].sort();
  }
}

export const operationBaselineHash = (value: FabricValue): string =>
  hashStringOf(encodeMemoryBoundary(value));

type CodeMirrorUpdateWire = {
  clientId: string;
  changes: FabricValue;
};

const decodeUpdate = (value: unknown): Update => {
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    typeof (value as { clientId?: unknown }).clientId !== "string" ||
    (value as { clientId: string }).clientId.length === 0 ||
    (value as { clientId: string }).clientId.length > 256
  ) {
    throw new Error("CodeMirror operation updates require a clientId");
  }
  const keys = Object.keys(value);
  if (
    keys.length !== 2 || !keys.includes("clientId") ||
    !keys.includes("changes")
  ) {
    throw new Error(
      "CodeMirror operation updates contain unsupported fields",
    );
  }
  return {
    clientID: (value as { clientId: string }).clientId,
    changes: ChangeSet.fromJSON(
      (value as { changes: Parameters<typeof ChangeSet.fromJSON>[0] }).changes,
    ),
  };
};

const decodePayload = (payload: FabricValue): Update[] => {
  if (
    payload === null || typeof payload !== "object" ||
    Array.isArray(payload) ||
    !Array.isArray((payload as { updates?: unknown }).updates)
  ) {
    throw new Error("CodeMirror operation payload requires an updates array");
  }
  if (
    Object.keys(payload).length !== 1 ||
    !Object.hasOwn(payload, "updates")
  ) {
    throw new Error("CodeMirror operation payload contains unsupported fields");
  }
  return (payload as { updates: unknown[] }).updates.map(decodeUpdate);
};

const encodeUpdate = (update: Update): CodeMirrorUpdateWire => ({
  clientId: update.clientID,
  changes: update.changes.toJSON() as FabricValue,
});

const codeMirrorChangeSetCodec: OperationCodec = {
  id: CODEMIRROR_CHANGESET_CODEC,
  integrate({ materialized, submitted, intervening }) {
    if (typeof materialized !== "string") {
      throw new Error("CodeMirror operations require a string field");
    }
    const over = intervening.flatMap(decodePayload);
    const accepted = rebaseUpdates(decodePayload(submitted), over);
    let document = Text.of(materialized.split("\n"));
    for (const update of accepted) {
      document = update.changes.apply(document);
    }
    return {
      materialized: document.toString(),
      operations: accepted.map((update) => ({
        updates: [encodeUpdate(update)],
      })),
    };
  },
};

export const createDefaultOperationCodecRegistry = () =>
  new OperationCodecRegistry([codeMirrorChangeSetCodec]);
