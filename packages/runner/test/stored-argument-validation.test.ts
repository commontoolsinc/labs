/**
 * Checks stored-argument validation and its fallback with real storage graphs.
 * Direct overlay cases supply cyclic snapshots that eager reads reject before
 * the fallback can exercise its own termination and cache guards.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import type { JSONSchema } from "../src/builder/types.ts";
import { extractDefaultValues } from "../src/runner-utils.ts";
import { Runtime } from "../src/runtime.ts";
import {
  overlayUnreadableLinkPlaceholders,
  storedArgumentValidationIssue,
} from "../src/stored-argument-validation.ts";

/** Materialized snapshot whose back edge remains observable by identity. */
interface MaterializedNode {
  /** Linked value that materialization could not read. */
  pending: unknown;

  /** Optional back edge through the materialized graph. */
  next?: MaterializedNode;
}

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

  it("rebuilds each cyclic descent without reusing a partial sibling overlay", () => {
    const tx = runtime.edit();
    try {
      const absent = runtime.getCell(space, "absent", undefined, tx);
      const a = runtime.getCell(space, "cycle-a", undefined, tx);
      const b = runtime.getCell(space, "cycle-b", undefined, tx);
      a.set({ next: b, pending: absent });
      b.set({ next: a, pending: absent });
      const argument = runtime.getCell(space, "argument", undefined, tx);
      argument.set({ first: a, second: b });
      const node: MaterializedNode = { pending: undefined };
      node.next = node;
      const snapshot = { first: node, second: node };
      const result = overlayUnreadableLinkPlaceholders(
        tx,
        argument.getAsNormalizedFullLink(),
        argument.getRaw(),
        snapshot,
      ) as typeof snapshot;

      for (const entry of [result.first, result.second]) {
        expect(entry.pending).toBeDefined();
        expect(entry.next?.pending).toBeDefined();
        expect(entry.next?.next).toBe(node);
      }
      expect(node.pending).toBeUndefined();
      expect(node.next).toBe(node);
      expect(snapshot.first).toBe(node);
      expect(snapshot.second).toBe(node);
    } finally {
      tx.abort();
    }
  });

  it("revisits an alias whose first resolution reaches an active ancestor", () => {
    const tx = runtime.edit();
    try {
      const absent = runtime.getCell(space, "absent", undefined, tx);
      const a = runtime.getCell(space, "cycle-a", undefined, tx);
      const alias = runtime.getCell(space, "cycle-alias", undefined, tx);
      a.set({ next: alias, pending: absent });
      alias.set(a);
      const argument = runtime.getCell(space, "argument", undefined, tx);
      argument.set({ first: a, second: alias });
      const node: MaterializedNode = { pending: undefined };
      node.next = node;
      const snapshot = { first: node, second: node };
      const result = overlayUnreadableLinkPlaceholders(
        tx,
        argument.getAsNormalizedFullLink(),
        argument.getRaw(),
        snapshot,
      ) as typeof snapshot;

      expect(result.first.pending).toBeDefined();
      expect(result.first.next).toBe(node);
      expect(result.second.pending).toBeDefined();
      expect(result.second.next).toBe(node);
      expect(node.pending).toBeUndefined();
      expect(snapshot.first).toBe(node);
      expect(snapshot.second).toBe(node);
    } finally {
      tx.abort();
    }
  });
});
