import { handler, SqliteDb } from "commonfabric";

interface DbState {
  db: SqliteDb;
}

// FIXTURE: sqlite-db-handler-state
// Verifies: a SqliteDb-typed handler-state field lowers to { asCell: ["sqlite"] }
// (the brand recognition added to the schema-generator), so the runtime delivers
// a "sqlite"-kind cell on which db.exec(...) is valid.
const writeNote = handler<unknown, DbState>((_, { db }) => {
  db.exec("INSERT INTO notes (body) VALUES (?)", ["hi"]);
});

export { writeNote };
