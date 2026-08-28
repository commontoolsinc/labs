/**
 * Tests AmountLedger: that the total is the sum of the rows to the penny, and
 * that the budget reports both directions.
 *
 * Run: deno task cf test packages/patterns/primitives/amount-ledger.test.tsx
 */
import { action, assert, pattern, TESTS } from "commonfabric";
import AmountLedger from "./amount-ledger.tsx";

export default pattern(() => {
  const ledger = AmountLedger({ budget: 500 });
  const free = AmountLedger({});

  const addHotel = action(() =>
    ledger.addEntry.send({ label: "Hotel", amount: 420 })
  );
  const addFood = action(() =>
    ledger.addEntry.send({ label: "Groceries", amount: 86.4 })
  );
  const addBlank = action(() =>
    ledger.addEntry.send({ label: "   ", amount: 10 })
  );
  const removeFirst = action(() =>
    ledger.removeEntry.send({ entry: ledger.entries[0] })
  );
  // Thirds are where a float total drifts away from the rows that produced it.
  const addThirds = action(() => {
    free.addEntry.send({ label: "a", amount: 0.1 });
    free.addEntry.send({ label: "b", amount: 0.2 });
  });

  return {
    [TESTS]: [
      { assertion: assert(() => ledger.total === 0) },
      { assertion: assert(() => ledger.entryCount === 0) },
      { assertion: assert(() => ledger.overBudget === false) },

      { action: addHotel },
      { assertion: assert(() => ledger.total === 420) },
      { assertion: assert(() => ledger.formattedTotal === "$420.00") },
      { assertion: assert(() => ledger.remaining === 80) },

      { action: addFood },
      { assertion: assert(() => ledger.total === 506.4) },
      { assertion: assert(() => ledger.formattedTotal === "$506.40") },
      // Past the budget, `remaining` goes negative and `overBudget` says so.
      { assertion: assert(() => ledger.remaining === -6.4) },
      { assertion: assert(() => ledger.overBudget === true) },

      // An entry with no label is not an expense anyone can read.
      { action: addBlank },
      { assertion: assert(() => ledger.entryCount === 2) },

      { action: removeFirst },
      { assertion: assert(() => ledger.entryCount === 1) },
      { assertion: assert(() => ledger.total === 86.4) },

      // Summed in cents, so the total equals the rows rather than 0.30000000000000004.
      { action: addThirds },
      { assertion: assert(() => free.total === 0.3) },
      { assertion: assert(() => free.formattedTotal === "$0.30") },
      // With no budget there is nothing to be over.
      { assertion: assert(() => free.overBudget === false) },
      { assertion: assert(() => free.remaining === 0) },
    ],
  };
});
