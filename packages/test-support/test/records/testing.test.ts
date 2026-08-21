import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";

import {
  FragmentWriter,
  RECORDS_DIR_VARIABLE,
  recordsSpooledBy,
  type TestRecord,
} from "@commonfabric/test-support/records";

const RECORD: TestRecord = {
  line: "record",
  test: { k: "unit", s: "bakery", n: "glaze > sets" },
  outcome: "pass",
  durationMs: 5,
};

describe("recordsSpooledBy()", () => {
  it("returns records and skips other spool contents", async () => {
    const records = await recordsSpooledBy(async () => {
      const dir = Deno.env.get(RECORDS_DIR_VARIABLE);
      expect(dir).toBeDefined();
      await Deno.mkdir(join(dir!, "nested"));
      await Deno.writeTextFile(join(dir!, "empty.ndjson"), "\n");

      const writer = FragmentWriter.openForRun();
      expect(writer).toBeDefined();
      writer!.append(RECORD);
      writer!.close();
    });

    expect(records).toEqual([RECORD]);
  });

  it("restores an existing spool variable", async () => {
    const before = Deno.env.get(RECORDS_DIR_VARIABLE);
    Deno.env.set(RECORDS_DIR_VARIABLE, "outer-spool");
    try {
      await recordsSpooledBy(() => {
        expect(Deno.env.get(RECORDS_DIR_VARIABLE)).not.toBe("outer-spool");
        return Promise.resolve();
      });
      expect(Deno.env.get(RECORDS_DIR_VARIABLE)).toBe("outer-spool");
    } finally {
      if (before === undefined) {
        Deno.env.delete(RECORDS_DIR_VARIABLE);
      } else {
        Deno.env.set(RECORDS_DIR_VARIABLE, before);
      }
    }
  });

  it("leaves the spool variable unset when it began unset", async () => {
    const before = Deno.env.get(RECORDS_DIR_VARIABLE);
    Deno.env.delete(RECORDS_DIR_VARIABLE);
    try {
      await recordsSpooledBy(() => {
        expect(Deno.env.get(RECORDS_DIR_VARIABLE)).toBeDefined();
        return Promise.resolve();
      });
      expect(Deno.env.get(RECORDS_DIR_VARIABLE)).toBeUndefined();
    } finally {
      if (before !== undefined) {
        Deno.env.set(RECORDS_DIR_VARIABLE, before);
      }
    }
  });
});
