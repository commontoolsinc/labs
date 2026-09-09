import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { JSONSchema } from "../src/builder/types.ts";
import { extractDefaultValues } from "../src/runner-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { storedArgumentValidationIssue } from "../src/stored-argument-validation.ts";

const signer = await Identity.fromPassphrase("stored-argument-validation");
const space = signer.did();

describe("stored-argument-validation", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storage = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storage.close();
  });

  it("defers unreadable leaves in a shared graph with work proportional to its nodes", () => {
    const tx = runtime.edit();
    try {
      const absent = runtime.getCell(space, "absent", undefined, tx);
      let next = runtime.getCell(space, "leaf", undefined, tx);
      next.set({ pending: absent });
      const graphIds = new Set([next.getAsNormalizedFullLink().id]);
      for (let depth = 0; depth < 12; depth++) {
        const node = runtime.getCell(space, `node-${depth}`, undefined, tx);
        node.set({ left: next, right: next, pending: absent });
        graphIds.add(node.getAsNormalizedFullLink().id);
        next = node;
      }
      const argument = runtime.getCell(space, "argument", undefined, tx);
      argument.set({ graph: next });
      const schema: JSONSchema = {
        type: "object",
        properties: { graph: { $ref: "#/$defs/Node" } },
        $defs: {
          Node: {
            type: "object",
            properties: {
              left: { $ref: "#/$defs/Node" },
              right: { $ref: "#/$defs/Node" },
              pending: { type: "string" },
            },
            required: ["pending"],
          },
        },
      };
      const before = argument.getRaw();
      using reads = spy(tx, "read");
      expect(storedArgumentValidationIssue(argument, schema, undefined, tx))
        .toBeUndefined();
      const graphReads = reads.calls.filter((call) =>
        graphIds.has(call.args[0].id)
      ).length;
      expect(graphReads).toBeGreaterThan(0);
      expect(graphReads).toBeLessThan(100 * graphIds.size);
      expect(argument.getRaw()).toEqual(before);
    } finally {
      tx.abort();
    }
  });

  it("keeps differently defaulted views of one linked endpoint distinct", () => {
    const tx = runtime.edit();
    try {
      const absent = runtime.getCell(space, "absent", undefined, tx);
      const shared = runtime.getCell(space, "shared", undefined, tx);
      shared.set({ pending: absent });
      const argument = runtime.getCell(space, "argument", undefined, tx);
      argument.set({ left: shared, right: shared });
      const schema: JSONSchema = {
        type: "object",
        properties: Object.fromEntries(["left", "right"].map((tag) => [tag, {
          type: "object",
          properties: {
            pending: { type: "string" },
            tag: { type: "string", const: tag, default: tag },
          },
          required: ["pending", "tag"],
        }])),
        required: ["left", "right"],
      };
      const defaults = extractDefaultValues(schema);
      expect(storedArgumentValidationIssue(argument, schema, defaults, tx))
        .toBeUndefined();

      // Reusing a completed overlay must not hide a value staged by a later
      // validation, even when both validations use the same transaction.
      absent.set(42);
      expect(storedArgumentValidationIssue(argument, schema, defaults, tx))
        .toContain("pending: value does not match type string");
    } finally {
      tx.abort();
    }
  });
});
