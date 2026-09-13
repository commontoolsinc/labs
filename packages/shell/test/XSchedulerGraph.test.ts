import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { XSchedulerGraph } from "../src/views/SchedulerGraphView.ts";

const { truncateLabel } = XSchedulerGraph.accessForTestingOnly;

/** A space id long enough that no label holding it fits the default bound. */
const SPACE = "did:key:z6MkabcdefghijkLMNOP";

describe("XSchedulerGraph", () => {
  describe("static members", () => {
    describe("#truncateLabel()", () => {
      // Each expectation is the whole label the method assembles, so a case
      // turns on the assembly itself and not on a fragment surviving it.

      it("returns a label no longer than the default bound unchanged", () => {
        expect(truncateLabel("parentAction")).toBe("parentAction");
        expect(truncateLabel("a".repeat(20))).toBe("a".repeat(20));
      });

      it("returns a label no longer than a given `maxLen` unchanged", () => {
        expect(truncateLabel("abcdefghij", 10)).toBe("abcdefghij");
      });

      describe("given a schemed entity segment", () => {
        it("returns the prefix, the last four characters of the entity, and the path", () => {
          expect(
            truncateLabel(`sink:${SPACE}/of:fid1:AAAABBBBCCCCDDDD/value`),
          ).toBe("sink:...DDDD/value");
        });

        it("returns a `computed:` entity the same way as an `of:` one", () => {
          expect(
            truncateLabel(
              `action:${SPACE}/computed:fid1:EEEEFFFFGGGGHHHH/count`,
            ),
          ).toBe("action:...HHHH/count");
        });

        it("keeps the prefix in the case the label wrote it", () => {
          expect(
            truncateLabel(`Sink:${SPACE}/of:fid1:AAAABBBBCCCCDDDD/value`),
          ).toBe("Sink:...DDDD/value");
        });

        it("returns no prefix when the label has none", () => {
          expect(
            truncateLabel(`${SPACE}/of:fid1:AAAABBBBCCCCDDDD/value`),
          ).toBe("...DDDD/value");
        });

        it("returns no path when only empty segments follow the entity", () => {
          expect(
            truncateLabel(`sink:${SPACE}/of:fid1:AAAABBBBCCCCDDDD/`),
          ).toBe("sink:...DDDD");
        });

        it("cuts the path to fit when the assembled label is still too long", () => {
          expect(
            truncateLabel(
              `sink:${SPACE}/of:fid1:AAAABBBBCCCCDDDD/some/deeply/nested/path`,
            ),
          ).toBe("sink:...DDDD/some...");
        });

        it("cuts the assembled label to a given `maxLen`", () => {
          expect(
            truncateLabel(`sink:${SPACE}/of:fid1:AAAABBBBCCCCDDDD/value`, 12),
          ).toBe("sink:...D...");
        });
      });

      describe("given no schemed entity segment", () => {
        it("returns the last four characters of the first segment longer than 20 characters, then the segments after it", () => {
          expect(truncateLabel("space/abcdefghijklmnopqrstuvwx/count")).toBe(
            "...uvwx/count",
          );
        });

        it("returns the last four characters of the first segment when none is longer than 20 characters", () => {
          expect(truncateLabel("space/entity/some/longer/path")).toBe(
            "...pace/entity/so...",
          );
        });

        it("keeps an entity of four characters or fewer whole", () => {
          expect(truncateLabel("ab/cdefghijklmnopqrstu")).toBe(
            "ab/cdefghijklmnop...",
          );
        });
      });

      describe("given fewer than two non-empty segments", () => {
        it("cuts the label from the end", () => {
          expect(truncateLabel("aVeryLongActionIdentifierName")).toBe(
            "aVeryLongActionId...",
          );
        });

        it("returns the prefix as part of the cut label", () => {
          expect(truncateLabel("handler:someVeryLongHandlerName")).toBe(
            "handler:someVeryL...",
          );
        });

        it("cuts to a given `maxLen`", () => {
          expect(truncateLabel("abcdefghijk", 10)).toBe("abcdefg...");
        });

        it("cuts a lone segment followed by `/` the same way", () => {
          expect(truncateLabel("abcdefghijklmnopqrstuvwxyz/")).toBe(
            "abcdefghijklmnopq...",
          );
        });
      });
    });
  });
});
