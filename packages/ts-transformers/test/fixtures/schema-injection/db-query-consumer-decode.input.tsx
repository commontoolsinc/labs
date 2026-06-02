import { type Cell, derive, pattern, sqliteDatabase } from "commonfabric";

interface User {
  name: string;
}

// FIXTURE: db-query-consumer-decode
// Verifies the CONSUMER half of `_cf_link` auto-decode: reading
// `q.result[0].author_cf_link` off a typed `db.query<{ author_cf_link: Cell<User> }>`
// lowers (via the <Row> return type) to a derive input schema where
// `result.items.author_cf_link` carries `asCell: ["cell"]`. Combined with the
// runtime storing a sigil OBJECT (Piece A), that asCell read rehydrates the
// column to a live Cell.
export default pattern(() => {
  const db = sqliteDatabase();
  const q = db.query<{ author_cf_link: Cell<User> }>(
    "SELECT author_cf_link FROM people",
  );
  return { author: derive(q, (qv) => qv.result?.[0]?.author_cf_link) };
});
