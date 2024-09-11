import { db } from "./db.ts";

export function printItem(itemId: number, showRaw: boolean = false) {
  const item = db.query<
    [number, string, string, string, string, string, string]
  >(
    "SELECT id, url, title, content, raw_content, source, created_at FROM items WHERE id = ?",
    [itemId],
  )[0];

  if (!item) {
    console.log(`Item with ID ${itemId} not found.`);
    return;
  }

  const [id, url, title, content, rawContent, source, createdAt] = item;

  console.log(`Item ID: ${id}`);
  console.log(`URL: ${url}`);
  console.log(`Title: ${title}`);
  console.log(`Source: ${source}`);
  console.log(`Created At: ${createdAt}`);
  console.log("\nContent:");

  try {
    const contentObj = JSON.parse(content);
    console.log(JSON.stringify(contentObj, null, 2));
  } catch (error) {
    console.log("Error parsing JSON content:", error.message);
    console.log("Raw content:", content);
  }

  if (showRaw) {
    console.log("\nRaw Content:");
    console.log(rawContent);
  }

  // Print associated collections
  const collections = db.query<[string]>(
    `SELECT c.name
     FROM collections c
     JOIN item_collections ic ON c.id = ic.collection_id
     WHERE ic.item_id = ?`,
    [itemId],
  );

  if (collections.length > 0) {
    console.log("\nAssociated Collections:");
    collections.forEach(([name]) => console.log(`- ${name}`));
  }
}

export function deleteItem(itemId: number) {
  try {
    db.query("BEGIN TRANSACTION");

    // Delete from item_collections first to maintain referential integrity
    db.query("DELETE FROM item_collections WHERE item_id = ?", [itemId]);

    // Then delete the item itself
    const result = db.query("DELETE FROM items WHERE id = ?", [itemId]);

    db.query("COMMIT");

    if (result.length > 0) {
      console.log(`Item with ID ${itemId} has been deleted.`);
    } else {
      console.log(`No item found with ID ${itemId}.`);
    }
  } catch (error) {
    db.query("ROLLBACK");
    console.error(`Error deleting item: ${error.message}`);
  }
}

export async function editItem(
  itemId: number,
  editRawContent: boolean = false,
) {
  const item = db.query<[string, string]>(
    "SELECT content, raw_content FROM items WHERE id = ?",
    [itemId],
  )[0];

  if (!item) {
    console.log(`Item with ID ${itemId} not found.`);
    return;
  }

  const [content, rawContent] = item;
  const contentToEdit = editRawContent ? rawContent : content;

  // Create a temporary file
  const tempFile = await Deno.makeTempFile({ suffix: ".txt" });
  await Deno.writeTextFile(tempFile, contentToEdit);

  // Open the editor
  const editor = Deno.env.get("EDITOR") || "nano";
  const process = Deno.run({
    cmd: [editor, tempFile],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  // Wait for the editor to close
  await process.status();

  // Read the edited content
  const editedContent = await Deno.readTextFile(tempFile);

  // Update the database if the content has changed
  if (editedContent !== contentToEdit) {
    try {
      if (editRawContent) {
        db.query("UPDATE items SET raw_content = ? WHERE id = ?", [
          editedContent,
          itemId,
        ]);
      } else {
        db.query("UPDATE items SET content = ? WHERE id = ?", [
          editedContent,
          itemId,
        ]);
      }
      console.log(`Item ${itemId} has been updated.`);
    } catch (error) {
      console.error(`Error updating item: ${error.message}`);
    }
  } else {
    console.log("No changes were made.");
  }

  // Clean up the temporary file
  await Deno.remove(tempFile);
}

export function purge() {
  try {
    db.query("BEGIN TRANSACTION");

    // Find and delete items that are not members of any collection
    const result = db.query(`
      DELETE FROM items
      WHERE id NOT IN (
        SELECT DISTINCT item_id
        FROM item_collections
      )
    `);

    const purgedCount = result.length;

    db.query("COMMIT");

    console.log(
      `Purged ${purgedCount} items that were not members of any collection.`,
    );
  } catch (error) {
    db.query("ROLLBACK");
    console.error(`Error purging items: ${error.message}`);
  }
}
