import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Cell, OpaqueRef, reduce } from "commontools";

describe("reduce type inference", () => {
  // These tests are not meant to run, the test is that they compile correctly.
  function _doNotRun(): void {
    it("should infer result type from reducer return with plain array", () => {
      // Using plain array for type checking purposes
      const numbers = [1, 2, 3, 4, 5];

      const sum = reduce(numbers, 0, (acc, item) => {
        // Type check: acc should be number, item should be number
        const _accCheck: number = acc;
        const _itemCheck: number = item;
        return acc + item;
      });

      // Result should be OpaqueRef<number>
      const _typeCheck: OpaqueRef<number> = sum;
      expect(sum).toBeDefined();
    });

    it("should infer result type from Cell<T[]> input", () => {
      const numbers = Cell.of<number[]>();
      numbers.set([1, 2, 3, 4, 5]);

      const sum = reduce(numbers, 0, (acc, item) => {
        // Type check: acc should be number, item should be number
        const _accCheck: number = acc;
        const _itemCheck: number = item;
        return acc + item;
      });

      // Result should be OpaqueRef<number>
      const _typeCheck: OpaqueRef<number> = sum;
      expect(sum).toBeDefined();
    });

    it("should handle object accumulator types", () => {
      interface Item {
        category: string;
        value: number;
      }

      const items: Item[] = [
        { category: "a", value: 10 },
        { category: "b", value: 20 },
        { category: "a", value: 30 },
      ];

      type CategoryTotals = Record<string, number>;

      const totals = reduce(items, {} as CategoryTotals, (acc, item) => {
        // Type check
        const _accCheck: CategoryTotals = acc;
        const _itemCheck: Item = item;

        return {
          ...acc,
          [item.category]: (acc[item.category] ?? 0) + item.value,
        };
      });

      // Result should be OpaqueRef<CategoryTotals>
      const _typeCheck: OpaqueRef<CategoryTotals> = totals;
      expect(totals).toBeDefined();
    });

    it("should handle array result types", () => {
      const numbers = [1, 2, 3, 4, 5];

      // Filter odd numbers using reduce
      const odds = reduce(numbers, [] as number[], (acc, item) => {
        const _accCheck: number[] = acc;
        const _itemCheck: number = item;
        return item % 2 === 1 ? [...acc, item] : acc;
      });

      const _typeCheck: OpaqueRef<number[]> = odds;
      expect(odds).toBeDefined();
    });

    it("should provide index parameter", () => {
      const items = ["a", "b", "c"];

      const indexed = reduce(items, "", (acc, item, index) => {
        // Type check: index should be number
        const _indexCheck: number = index;
        return acc + `${index}:${item},`;
      });

      expect(indexed).toBeDefined();
    });

    it("should handle boolean result type", () => {
      const numbers = [2, 4, 6, 8];

      // Check if all numbers are even
      const allEven = reduce(numbers, true, (acc, item) => {
        return acc && item % 2 === 0;
      });

      const _typeCheck: OpaqueRef<boolean> = allEven;
      expect(allEven).toBeDefined();
    });

    it("should handle tuple result type", () => {
      const numbers = [1, 2, 3, 4, 5];

      // Find min and max
      const minMax = reduce(
        numbers,
        [Infinity, -Infinity] as [number, number],
        (acc, item) => {
          return [Math.min(acc[0], item), Math.max(acc[1], item)] as [
            number,
            number,
          ];
        },
      );

      const _typeCheck: OpaqueRef<[number, number]> = minMax;
      expect(minMax).toBeDefined();
    });

    it("should handle string accumulator", () => {
      const items = ["Hello", "World"];

      const joined = reduce(items, "", (acc, item, index) => {
        return acc + (index > 0 ? " " : "") + item;
      });

      const _typeCheck: OpaqueRef<string> = joined;
      expect(joined).toBeDefined();
    });

    it("should work with complex nested types", () => {
      interface Transaction {
        type: "credit" | "debit";
        amount: number;
        description: string;
      }

      interface Summary {
        totalCredits: number;
        totalDebits: number;
        transactions: string[];
      }

      const transactions: Transaction[] = [
        { type: "credit", amount: 100, description: "Payment" },
        { type: "debit", amount: 50, description: "Purchase" },
      ];

      const summary = reduce(
        transactions,
        { totalCredits: 0, totalDebits: 0, transactions: [] } as Summary,
        (acc, tx) => {
          const _accCheck: Summary = acc;
          const _txCheck: Transaction = tx;

          return {
            totalCredits: acc.totalCredits +
              (tx.type === "credit" ? tx.amount : 0),
            totalDebits: acc.totalDebits +
              (tx.type === "debit" ? tx.amount : 0),
            transactions: [...acc.transactions, tx.description],
          };
        },
      );

      const _typeCheck: OpaqueRef<Summary> = summary;
      expect(summary).toBeDefined();
    });
  }
});
