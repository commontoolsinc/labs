import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { Database } from "@db/sqlite";
import { toFileUrl } from "@std/path";
import { applyCommit, close, open } from "@commonfabric/memory/v2/engine";
import { toValuePath } from "@commonfabric/memory/v2";
import {
  CODEMIRROR_CHANGESET_CODEC,
  operationBaselineHash,
} from "@commonfabric/memory/v2/operation-codec";
import { inspect } from "../commands/inspect.ts";

async function output(argv: string[]): Promise<string> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...values: unknown[]) => lines.push(values.join(" "));
  try {
    await inspect.parse(argv);
    return lines.join("\n");
  } finally {
    console.log = original;
  }
}

describe("cf inspect operations", () => {
  it("renders unavailable, empty, active, truncated, and JSON reports", async () => {
    const directory = await Deno.makeTempDir({ prefix: "inspect-operations-" });
    try {
      const oldStore = `${directory}/old.sqlite`;
      new Database(oldStore, { create: true }).close();
      expect(await output(["operations", oldStore])).toContain(
        "operation tables are absent",
      );

      const path = `${directory}/operations.sqlite`;
      const engine = await open({ url: toFileUrl(path) });
      try {
        applyCommit(engine, {
          sessionId: "session:setup",
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: ["a", "b"].map((name) => ({
              op: "set" as const,
              id: `of:${name}`,
              value: { value: { body: "x" } },
            })),
          },
        });
        applyCommit(engine, {
          sessionId: "session:writer",
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: ["a", "b"].map((name) => ({
              op: "apply-op" as const,
              id: `of:${name}`,
              path: toValuePath(["body"]),
              codec: CODEMIRROR_CHANGESET_CODEC,
              submissionId: `${name}:1`,
              base: null,
              baselineHash: operationBaselineHash("x"),
              payload: {
                updates: [{ clientId: name, changes: [1, [0, "y"]] }],
              },
            })),
          },
        });
      } finally {
        close(engine);
      }

      expect(await output(["operations", path, "of:missing"])).toContain(
        "no collaborative operation fields",
      );
      const human = await output(["operations", path, "--limit", "1"]);
      expect(human).toContain("active\tof:a");
      expect(human).toContain("submissions=1 integrated=1 checkpoints=1");
      expect(human).toContain("field list truncated at 1");

      const json = JSON.parse(
        await output([
          "operations",
          path,
          "of:a",
          "--json",
        ]),
      );
      expect(json.fields[0].address.id).toBe("of:a");
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });
});
