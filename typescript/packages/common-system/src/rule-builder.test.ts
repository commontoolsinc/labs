import assert from "assert";
import { refer} from "synopsys";
import { where, select, TransactionBuilder } from "./rule-builder.js";
import { div } from "@gozala/co-dom";
import { Reference } from "merkle-reference";

describe("Rule Builder", () => {
  describe("Where", () => {
    it("should create where clause with match", () => {
      const id = refer(1);
      const w = where().match(id, "attr1", "value1");
      const clauses = w.commit();

      assert.deepStrictEqual(clauses, [
        {
          Case: [id, "attr1", "value1"],
        },
      ]);
    });

    it("should handle or conditions", () => {
      const id = refer(1);
      const w = where().or((q) => q.match(id, "attr1", "value1"));
      const clauses = w.commit();

      assert.deepStrictEqual(clauses, [
        {
          Or: [
            {
              Case: [id, "attr1", "value1"],
            },
          ],
        },
      ]);
    });

    it("should handle and conditions", () => {
      const id = refer(1);
      const w = where().and((q) => q.match(id, "attr1", "value1"));
      const clauses = w.commit();

      assert.deepStrictEqual(clauses, [
        {
          And: [
            {
              Case: [id, "attr1", "value1"],
            },
          ],
        },
      ]);
    });

    it("should handle not conditions", () => {
      const id = refer(1);
      const w = where().not((q) => q.match(id, "attr1", "value1"));
      const clauses = w.commit();

      assert.deepStrictEqual(clauses, [
        {
          Not: {
            And: [
              {
                Case: [id, "attr1", "value1"],
              },
            ],
          },
        },
      ]);
    });
  });

  describe("Select", () => {
    it("should create basic select query", () => {
      const id = refer(1);
      const s = select({ var1: "entity1" }).match(id, "attr1", "value1");
      const query = s.commit();

      assert.deepStrictEqual(query.select, { var1: "entity1" });
      assert.deepStrictEqual(query.where, [
        {
          Case: [id, "attr1", "value1"],
        },
      ]);
      assert.strict(typeof query.update === "function");
    });
  });

  describe("Transaction", () => {
    describe("assert", () => {
      it("should create an Assert instruction", () => {
        const tx = new TransactionBuilder();
        const id1 = refer(1);

        const update = tx
          .assert(() => [id1, "attribute", "value"] as const)
          .commit();
        const result = update({});

        assert.deepStrictEqual(result, [
          { Assert: [id1, "attribute", "value"] },
        ]);
      });
    });

    describe("retract", () => {
      it("should create a Retract instruction", () => {
        const tx = new TransactionBuilder();
        const id1 = refer(1);
        const update = tx
          .retract(() => [id1, "attribute", "value"] as const)
          .commit();
        const result = update({});

        assert.deepStrictEqual(result, [
          { Retract: [id1, "attribute", "value"] },
        ]);
      });
    });

    describe("upsert", () => {
      it("should create an Upsert instruction", () => {
        const tx = new TransactionBuilder();
        const id1 = refer(1);
        const update = tx
          .upsert(() => [id1, "attribute", "value"] as const)
          .commit();
        const result = update({});

        assert.deepStrictEqual(result, [
          { Upsert: [id1, "attribute", "value"] },
        ]);
      });
    });

    describe("update", () => {
      it("should add custom update instructions", () => {
        const tx = new TransactionBuilder();
        const id1 = refer(1);
        const id2 = refer(1);

        const update = tx
          .update(() => [
            { Assert: [id1, "attr1", "val1"] },
            { Retract: [id2, "attr2", "val2"] },
          ])
          .commit();

        const result = update({});

        assert.deepStrictEqual(result, [
          { Assert: [id1, "attr1", "val1"] },
          { Retract: [id2, "attr2", "val2"] },
        ]);
      });
    });

    describe("render", () => {
      it("should create an Assert instruction with UI node", () => {
        const id1 = refer(1);
        const tx = new TransactionBuilder<{ self: Reference<1> }>();

        const update = tx.render(() => div()).commit();

        const result = update({
          self: id1,
        });

        assert.deepStrictEqual(result, [
          {
            Assert: [id1, "~/common/ui", div()],
          },
        ]);
      });
    });

    describe("commit", () => {
      it("should combine multiple updates", () => {
        const tx = new TransactionBuilder();

        const id1 = refer(1);
        const edit1 = () => [id1, "attr1", "val1"] as const;

        const id2 = refer(1);
        const edit2 = () => [id2, "attr2", "val2"] as const;

        const update = tx.assert(edit1).retract(edit2).commit();
        const result = update({});

        assert.deepStrictEqual(result, [
          { Assert: [id1, "attr1", "val1"] },
          { Retract: [id2, "attr2", "val2"] },
        ]);
      });

      it("should handle empty transaction", () => {
        const tx = new TransactionBuilder();
        const update = tx.commit();
        const result = update({});
        assert.deepStrictEqual(result, []);
      });
    });
  });
});
