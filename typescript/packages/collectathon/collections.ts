// collections.ts
import { db } from "./db.ts";

export function getOrCreateCollection(name: string): number {
  const existing = db.query("SELECT id FROM collections WHERE name = ?", [
    name,
  ]);
  if (existing.length > 0) {
    return existing[0][0] as number;
  }
  const result = db.query(
    "INSERT INTO collections (name) VALUES (?) RETURNING id",
    [name]
  );
  return result[0][0] as number;
}

export async function listCollections() {
  const collections = db.query<[number, string, number]>(`
    SELECT c.id, c.name, COUNT(ic.item_id) as item_count
    FROM collections c
    LEFT JOIN item_collections ic ON c.id = ic.collection_id
    GROUP BY c.id
    ORDER BY c.name
  `);

  console.log("Collections:");
  for (const [id, name, itemCount] of collections) {
    console.log(`  ${id}: ${name} (${itemCount} items)`);
  }
}

export async function listItems(collectionName: string) {
  const items = db.query<[number, string, string]>(
    `
    SELECT i.id, i.title, i.url
    FROM items i
    JOIN item_collections ic ON i.id = ic.item_id
    JOIN collections c ON ic.collection_id = c.id
    WHERE c.name = ?
    ORDER BY i.id
  `,
    [collectionName]
  );

  if (items.length === 0) {
    console.log(`No items found in collection: ${collectionName}`);
    return;
  }

  console.log(`Items in collection "${collectionName}":`);
  for (const [id, title, url] of items) {
    console.log(`  ${id}: ${title} (${url})`);
  }
}

export async function addItemToCollection(
  itemId: number,
  collectionName: string
) {
  try {
    const collectionId = getOrCreateCollection(collectionName);
    db.query(
      "INSERT OR IGNORE INTO item_collections (item_id, collection_id) VALUES (?, ?)",
      [itemId, collectionId]
    );
    console.log(`Added item ${itemId} to collection "${collectionName}"`);
  } catch (error) {
    console.error(`Error adding item to collection: ${error.message}`);
  }
}

export async function removeItemFromCollection(
  itemId: number,
  collectionName: string
) {
  try {
    db.query(
      `
      DELETE FROM item_collections
      WHERE item_id = ? AND collection_id = (SELECT id FROM collections WHERE name = ?)
    `,
      [itemId, collectionName]
    );
    console.log(`Removed item ${itemId} from collection "${collectionName}"`);
  } catch (error) {
    console.error(`Error removing item from collection: ${error.message}`);
  }
}

export async function deleteCollection(collectionName: string) {
  try {
    db.query("BEGIN TRANSACTION");
    db.query(
      "DELETE FROM item_collections WHERE collection_id = (SELECT id FROM collections WHERE name = ?)",
      [collectionName]
    );
    db.query("DELETE FROM collections WHERE name = ?", [collectionName]);
    db.query("COMMIT");
    console.log(`Deleted collection "${collectionName}"`);
  } catch (error) {
    db.query("ROLLBACK");
    console.error(`Error deleting collection: ${error.message}`);
  }
}
