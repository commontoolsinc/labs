import { Database } from "jsr:@db/sqlite@^0.12.0";

const MIGRATIONS = new URL("./migrations/", import.meta.url);

class Migration {
  constructor(
    public db: Database,
    public id: number,
    public name: string,
    public url: URL,
  ) {}

  execute() {
    const content = Deno.readFileSync(this.url);
    this.db.exec(new TextDecoder().decode(content));
  }

  migrate() {
    this.execute();
    this.db.run(
      `INSERT INTO migration (id, title) VALUES (:id, :title)`,
      { id: this.id, title: this.name },
    );
  }
}

const migrations = (db: Database): Migration[] => {
  const migrations = Deno.readDirSync(MIGRATIONS).flatMap(
    ({ name, isFile }) => {
      const id = parseInt(name.slice(0, name.indexOf("-")));
      if (!isFile || isNaN(id)) {
        return [];
      } else {
        return [new Migration(db, id, name, new URL(name, MIGRATIONS))];
      }
    },
  );

  return [...migrations].sort((left, right) => left.id - right.id);
};

const current = (db: Database) =>
  db.prepare(
    `SELECT * FROM migration ORDER BY id DESC LIMIT 1;`,
  ).get() as { id: number; title: string; time: string };

export const migrate = (db: Database) => {
  const [setup, ...updates] = migrations(db);
  // First we run the setup
  setup.execute();
  const { time, id, title } = current(db);

  console.log(
    `🔎 DB was last migrated on ${time} to version ${id} via ${title}`,
  );

  try {
    let migration = null;
    for (migration of updates) {
      if (migration.id > id) {
        console.log(`⏭️ Migrating to ${migration.id} using ${migration.name}`);
        migration.migrate();
      } else {
        migration = null;
      }
    }

    if (migration) {
      console.log(`🏁 DB was successfully migrated to version ${migration.id}`);
    } else {
      console.log(`✅ DB is already at latest version ${id}`);
    }
  } catch (reason) {
    console.error(`💥 Migration failed`, reason);
  }
};
export const main = (database: string) => {
  const path = Deno.realPathSync(database);
  console.log(`💾 Loading ${path}`);
  const db = new Database(path, {
    create: false,
    unsafeConcurrency: true,
  });

  return db.transaction(migrate)(db);
};

main(...Deno.args as [string]);
