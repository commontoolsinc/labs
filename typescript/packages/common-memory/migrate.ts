import {
  Database,
  SqliteError,
  Transaction as DBTransaction,
} from "jsr:@db/sqlite";

export const main = (migration: string, database: string) => {
  const sql = new TextDecoder().decode(Deno.readFileSync(migration));
  const db = new Database(Deno.realPathSync(database), {
    create: false,
    unsafeConcurrency: true,
  });

  db.transaction(() => db.exec(sql))();
};

main(...Deno.args as [string, string]);
