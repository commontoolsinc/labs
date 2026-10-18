import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { approximateJsonSize } from "@commonfabric/utils/approximate-json-size";
import type { EntityDocument } from "@commonfabric/memory/v2";
import { DocumentSizeEstimate } from "../../src/storage/document-sizes.ts";

const document = (text: string): EntityDocument => ({ value: { text } });

describe("DocumentSizeEstimate", () => {
  describe("instance members", () => {
    describe("measure()", () => {
      it("measures every value while the budget lasts, and reports them all measured", () => {
        const estimate = new DocumentSizeEstimate();
        const values = [document("a"), document("bb"), undefined];
        const budget = { remaining: 1_000 };

        expect(estimate.measure(values, budget)).toEqual({
          documents: 3,
          measuredDocuments: 3,
          approxBytes: approximateJsonSize(values[0]).bytes +
            approximateJsonSize(values[1]).bytes,
        });
      });

      it("draws the budget down by the nodes it visits", () => {
        const estimate = new DocumentSizeEstimate();
        const value = document("a");
        const budget = { remaining: 1_000 };

        estimate.measure([value], budget);

        expect(budget.remaining).toBe(1_000 - approximateJsonSize(value).nodes);
      });

      it("leaves values unmeasured once the budget is spent, scaling the measured ones to all", () => {
        const estimate = new DocumentSizeEstimate();
        const values = [document("aa"), document("bb"), document("cc")];
        const each = approximateJsonSize(values[0]);

        const measured = estimate.measure(values, { remaining: each.nodes });

        expect(measured).toEqual({
          documents: 3,
          measuredDocuments: 1,
          approxBytes: each.bytes * 3,
        });
      });

      it("remembers a measured value, so a later read without budget still counts it", () => {
        const estimate = new DocumentSizeEstimate();
        const values = [document("aa"), document("bb")];
        estimate.measure(values, { remaining: 1_000 });

        const again = estimate.measure(values, { remaining: 0 });

        expect(again.measuredDocuments).toBe(2);
        expect(again.approxBytes).toBe(
          approximateJsonSize(values[0]).bytes * 2,
        );
      });

      it("measures a replaced value afresh", () => {
        const estimate = new DocumentSizeEstimate();
        estimate.measure([document("a")], { remaining: 1_000 });
        const replaced = document("a much longer text than before");

        const measured = estimate.measure([replaced], { remaining: 1_000 });

        expect(measured.approxBytes).toBe(approximateJsonSize(replaced).bytes);
      });

      it("returns zero bytes for values none of which the budget admitted", () => {
        const estimate = new DocumentSizeEstimate();

        expect(estimate.measure([document("a")], { remaining: 0 })).toEqual({
          documents: 1,
          measuredDocuments: 0,
          approxBytes: 0,
        });
      });
    });
  });
});
