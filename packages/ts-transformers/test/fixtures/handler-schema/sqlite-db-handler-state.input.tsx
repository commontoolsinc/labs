import { handler, SqliteDb } from "commonfabric";

interface DbState {
  db: SqliteDb;
}

// FIXTURE: sqlite-db-handler-state
// Verifies: a SqliteDb-typed handler-state field lowers to an asCell wrapper, so
// the handler receives the live handle cell and `db.exec(...)` is valid.
// NOTE on the brand: the ts-transformer's capability analysis infers
// `asCell: ["readonly"]` here, from SqliteDb's read-only method surface — it does
// NOT stamp the "sqlite" brand on the handler-state field (that brand comes from
// the schema-generator's object-formatter path). `["readonly"]` is benign for the
// handler case: `db.exec` reaches the transaction via the materialized handle
// regardless of the wrapper brand (proven end to end in
// runner/integration/sqlite-db-query-decode.test.tsx). The two-path brand
// inconsistency is tracked in 08-open-questions.
const writeNote = handler<unknown, DbState>((_, { db }) => {
  db.exec("INSERT INTO notes (body) VALUES (?)", ["hi"]);
});

export { writeNote };
