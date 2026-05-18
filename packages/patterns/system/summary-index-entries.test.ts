import { assertEquals } from "@std/assert";
import { collectSummaryEntries } from "./summary-index-entries.ts";

Deno.test("collectSummaryEntries skips non-cell mentionables", () => {
  const summaryCell = {
    get: () => ({
      $NAME: "Summary note",
      summary: "A useful summary",
    }),
  };

  assertEquals(
    collectSummaryEntries([
      { $NAME: "Plain value", summary: "No cell link available" },
      summaryCell,
      undefined,
    ]),
    [{
      piece: summaryCell,
      summary: "A useful summary",
      name: "Summary note",
    }],
  );
});
