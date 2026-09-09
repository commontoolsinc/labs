/**
 * Tests LedgerMonthTransactions: the tombstone rule, the month window, the
 * default month, the rendered list and empty state, and the failure text.
 *
 * The atom takes no `reactOn`, because a database it only reads has nothing to
 * react to. Its `month` input is reactive, so a test seeds the rows and then
 * names the month, which is what re-runs the query over them.
 *
 * Run: deno task cf test packages/patterns/primitives/ledger-month-transactions.test.tsx
 */
import {
  action,
  assert,
  handler,
  NAME,
  pattern,
  sqliteDatabase,
  type SqliteDb,
  table,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  findElementByText,
  findNodeByProp,
  textContent,
} from "../test/vnode-helpers.ts";
import LedgerMonthTransactions from "./ledger-month-transactions.tsx";

/** The ledger columns the atom projects, as the connector store declares them. */
const ledgerTable = () =>
  table({
    record_id: "text primary key",
    transaction_id: "text",
    account_id: "text",
    date: "text",
    amount: "real",
    signed_amount: "real",
    merchant_name: "text",
    name: "text",
    pending: "integer",
    category_primary: "text",
    iso_currency_code: "text",
    deleted: "integer",
    deleted_at: "text",
  });

const insertSql = (): string =>
  "INSERT INTO rows_plaid_transaction (record_id, transaction_id, " +
  "account_id, date, amount, signed_amount, merchant_name, name, pending, " +
  "category_primary, iso_currency_code, deleted, deleted_at) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

/**
 * Seeds one live row, one tombstone and one row in the next month. The
 * tombstone carries `deleted = 1` with `deleted_at` set and the live row
 * carries `deleted = 0` with `deleted_at` the empty string, which is how the
 * connector store writes both: the text column is never NULL either way.
 */
const seedLedger = handler<void, { db: SqliteDb }>((_, { db }) => {
  db.exec(insertSql(), [
    "live",
    "txn-live",
    "acct-1",
    "2026-03-04",
    84.2,
    -84.2,
    "Pacific Gas",
    "Pacific Gas autopay",
    0,
    "GENERAL_SERVICES",
    "USD",
    0,
    "",
  ]);
  db.exec(insertSql(), [
    "gone",
    "txn-gone",
    "acct-1",
    "2026-03-06",
    12,
    -12,
    "Refunded Co",
    "Refunded Co charge",
    0,
    "GENERAL_MERCHANDISE",
    "USD",
    1,
    "2026-03-07T12:00:00Z",
  ]);
  db.exec(insertSql(), [
    "later",
    "txn-later",
    "acct-1",
    "2026-04-02",
    9,
    -9,
    "Next Month Co",
    "Next Month Co charge",
    0,
    "GENERAL_SERVICES",
    "USD",
    0,
    "",
  ]);
});

export default pattern(() => {
  const db = sqliteDatabase({
    tables: { rows_plaid_transaction: ledgerTable() },
  });
  const seed = seedLedger({ db });

  // Both months start on one the seed puts nothing in. `month` is the atom's
  // one reactive input, so naming a month is what re-runs the query over rows
  // seeded after the atom was built.
  const month = new Writable("1970-01");
  // Session-scoped, because the atom's rows come from session-scoped queries
  // and a space-scoped slot holding a link to one resolves per reader.
  const ledger = LedgerMonthTransactions.asScope("session")({
    bank: db,
    month,
  });

  return {
    // The one warning this allows is normalizeAndDiff's "Storing a
    // session-scoped link in space-scoped data", raised when reading `[UI]`
    // puts a link to the atom's session-scoped query result into the vnode
    // tree. Per-reader resolution is what a session-scoped result is for, and
    // the slot holding the link is a view-node child the atom does not
    // declare. The flag is a boolean, so it cannot be pinned to that text.
    allowConsoleWarnings: true,
    [TESTS]: [
      { assertion: assert(() => ledger.rowCount === 0) },

      { action: action(() => seed.send()) },
      { action: action(() => month.set("2026-03")) },

      // The live row survives; the tombstone does not, and neither does the
      // row a month later.
      { assertion: assert(() => ledger.rowCount === 1) },
      {
        assertion: assert(() => ledger.rows[0].merchant_name === "Pacific Gas"),
      },
      { assertion: assert(() => ledger.rows[0].date === "2026-03-04") },
      { assertion: assert(() => ledger.rows[0].signed_amount === -84.2) },
      { assertion: assert(() => ledger.rows[0].pending === 0) },
      { assertion: assert(() => ledger.month === "2026-03") },
      { assertion: assert(() => ledger.errorMessage === "") },
      { assertion: assert(() => ledger[NAME] === "Transactions 2026-03 (1)") },

      // The rendered list states the same row: its merchant, and the amount
      // formatted under the row's own currency.
      {
        assertion: assert(() =>
          findElementByText(ledger[UI], "cf-text", "Pacific Gas") !== undefined
        ),
      },
      {
        assertion: assert(() => textContent(ledger[UI]).includes("-84.20 USD")),
      },
      {
        assertion: assert(() =>
          !textContent(ledger[UI]).includes("Refunded Co")
        ),
      },
      {
        assertion: assert(() =>
          findNodeByProp(
            ledger[UI],
            "message",
            "No transactions this month.",
          ) === undefined
        ),
      },

      // A month the seed left empty reads back empty rather than stale, and
      // the view says so.
      { action: action(() => month.set("2026-05")) },
      { assertion: assert(() => ledger.rowCount === 0) },
      { assertion: assert(() => ledger.month === "2026-05") },
      { assertion: assert(() => ledger.pending === false) },
      {
        assertion: assert(() =>
          findNodeByProp(
            ledger[UI],
            "message",
            "No transactions this month.",
          ) !== undefined
        ),
      },

      // Naming no month resolves one from the database's own clock rather
      // than leaving the window unbounded.
      { action: action(() => month.set("")) },
      { assertion: assert(() => ledger.month.length === 7) },
      { assertion: assert(() => ledger.month.charAt(4) === "-") },
      { assertion: assert(() => ledger.errorMessage === "") },
    ],
  };
});
