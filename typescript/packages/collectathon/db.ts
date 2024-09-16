import { DB } from "./deps.ts";

export const db = new DB("collections.db");

// Create tables
db.execute(`
  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT,
    title TEXT,
    content JSON,
    raw_content TEXT,
    source TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.execute(`
  CREATE TABLE IF NOT EXISTS collections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE
  )
`);

db.execute(`
  CREATE TABLE IF NOT EXISTS item_collections (
    item_id INTEGER,
    collection_id INTEGER,
    PRIMARY KEY (item_id, collection_id),
    FOREIGN KEY (item_id) REFERENCES items(id),
    FOREIGN KEY (collection_id) REFERENCES collections(id)
  )
`);

db.execute(`
  CREATE TABLE IF NOT EXISTS rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collection_name TEXT,
    rule TEXT,
    target_collection TEXT
  )
`);

db.execute(`
  CREATE TABLE IF NOT EXISTS views (
    id TEXT PRIMARY KEY,
    collection TEXT,
    html TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);
