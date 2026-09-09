/**
 * The family's taint record read as what it is: a file, whose contents are
 * data rather than state.
 *
 * Whatever wrote it last — an earlier run, a hand, a write this process could
 * not see finish — is not this process. Every shape it can hold has to come
 * back as an answer, and a shape this build cannot read has to come back as
 * `unknown` rather than as a family that saw nothing.
 */

import { expect } from "@std/expect";
import { join } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import {
  forgetWorkspaceTaintForTesting,
  useWorkspaceTaintRecord,
} from "../src/workspace-taint.ts";

const withRecord = async (
  contents: string,
  body: (familyRunId: string, path: string) => void,
): Promise<void> => {
  const dir = await Deno.makeTempDir({ prefix: "cf-harness-taint-" });
  const familyRunId = `family-${crypto.randomUUID()}`;
  const path = join(dir, "family-taint.json");
  try {
    await Deno.writeTextFile(path, contents);
    body(familyRunId, path);
  } finally {
    forgetWorkspaceTaintForTesting(familyRunId);
    await Deno.remove(dir, { recursive: true });
  }
};

const record = (taint: unknown): string =>
  JSON.stringify({
    type: "cf-harness.family-taint",
    version: 1,
    familyRunId: "family",
    taint,
  });

describe("the run family's taint record", () => {
  it("restores a label it can read", async () => {
    await withRecord(
      record({ kind: "known", label: { confidentiality: ["finance"] } }),
      (familyRunId, path) => {
        const read = useWorkspaceTaintRecord(familyRunId, path);

        expect(read.found).toBe(true);
        expect(read.taint).toEqual({
          kind: "known",
          label: { confidentiality: ["finance"] },
        });
      },
    );
  });

  it("reads a state it does not recognise as unknown", async () => {
    // Not a family that saw nothing: a record this build cannot read.

    for (
      const taint of [
        { kind: "clean" },
        { kind: "unknown" },
        { kind: "known", label: { confidentiality: "finance" } },
        "known",
        42,
        null,
      ]
    ) {
      await withRecord(record(taint), (familyRunId, path) => {
        const read = useWorkspaceTaintRecord(familyRunId, path);

        expect(read.found).toBe(true);
        expect(read.taint.kind).toBe("unknown");
      });
    }
  });

  it("answers rather than raising on a label it cannot serialize", async () => {
    // Deep but perfectly ordinary JSON: a recursive read raises `RangeError`
    // on it, and a raise here would leave the family reading as clean.

    let nest: unknown[] = ["finance"];
    for (let index = 0; index < 20_000; index++) {
      nest = [nest];
    }
    await withRecord(
      record({ kind: "known", label: { confidentiality: [nest] } }),
      (familyRunId, path) => {
        const read = useWorkspaceTaintRecord(familyRunId, path);

        expect(read.taint.kind).toBe("unknown");
      },
    );
  });

  it("reads a file that does not describe a family's state as unknown", async () => {
    // At this family's own path, but not this family's record. It cannot be
    // accounted for, and a family that cannot be accounted for has no label
    // to mint.

    for (
      const envelope of [
        { version: 1, familyRunId: "family", taint: { kind: "known" } },
        {
          type: "cf-harness.family-taint",
          version: 2,
          familyRunId: "family",
          taint: { kind: "known" },
        },
        { type: "cf-harness.family-taint", version: 1, taint: {} },
        [1, 2, 3],
      ]
    ) {
      await withRecord(JSON.stringify(envelope), (familyRunId, path) => {
        const read = useWorkspaceTaintRecord(familyRunId, path);

        expect(read.found).toBe(true);
        expect(read.taint.kind).toBe("unknown");
      });
    }
  });

  it("reads a record it cannot parse as absent", async () => {
    // Nothing this family wrote, so there is nothing to seed FROM — which is
    // a different answer from a record that says something unreadable.

    await withRecord("{ not json", (familyRunId, path) => {
      const read = useWorkspaceTaintRecord(familyRunId, path);

      expect(read.found).toBe(false);
    });
  });
});
