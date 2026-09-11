/**
 * Exercises cold nested filters and remote row edits across independent replicas.
 * Only derived rows are exposed; reading the result cannot warm raw vote entities.
 * These assertions cover row data. Browser-rendered content is a separate check.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { MultiRuntimeHarness } from "./multi-runtime-harness.ts";

const rootPath = join(import.meta.dirname!, "..");

describe("reactive vote rows across replicas", () => {
  it("includes remotely created vote entities in a nested row filter", async () => {
    const harness = await MultiRuntimeHarness.create({
      rootPath,
      programPath: join(
        import.meta.dirname!,
        "fixtures/reactive-vote-rows/nested.tsx",
      ),
      sessions: ["writer", "reader"],
    });
    try {
      const writer = harness.session("writer");
      const reader = harness.session("reader");
      await writer.send("cast", {
        key: "alice-one",
        optionId: "one",
        color: "green",
      });
      await harness.settle();
      expect(await reader.read(["rows"])).toEqual([
        { id: "one", colors: ["green"], names: ["alice-one"] },
        { id: "two", colors: [], names: [] },
      ]);
      await writer.send("cast", {
        key: "bob-two",
        optionId: "two",
        color: "yellow",
      });
      await harness.settle();
      expect(await reader.read(["rows"])).toEqual([
        { id: "one", colors: ["green"], names: ["alice-one"] },
        { id: "two", colors: ["yellow"], names: ["bob-two"] },
      ]);
    } finally {
      await harness.dispose();
    }
  });

  it("updates mapped row content after another replica edits a vote", async () => {
    const harness = await MultiRuntimeHarness.create({
      rootPath,
      programPath: join(
        import.meta.dirname!,
        "fixtures/reactive-vote-rows/mapped.tsx",
      ),
      sessions: ["writer", "reader"],
    });
    try {
      const writer = harness.session("writer");
      const reader = harness.session("reader");
      await writer.send("cast", {
        key: "alice-one",
        optionId: "one",
        color: "green",
      });
      await harness.settle();
      expect(await reader.read(["rows"])).toEqual([{
        id: "one",
        color: "green",
        names: "alice-one",
      }, { id: "two", color: "", names: "" }]);
      await writer.send("cast", {
        key: "alice-one",
        optionId: "one",
        color: "yellow",
      });
      await harness.settle();
      expect(await reader.read(["rows"])).toEqual([{
        id: "one",
        color: "yellow",
        names: "alice-one",
      }, { id: "two", color: "", names: "" }]);
    } finally {
      await harness.dispose();
    }
  });
});
