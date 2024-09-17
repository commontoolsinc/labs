import { db } from "./db.ts";
import { chat, smart } from "./llm.ts";
import { CoreMessage } from "npm:ai@3.3.21";
import { extractJsonShape } from "./schema.ts";
import { getOrCreateCollection, addItemToCollection } from "./collections.ts";

export async function handleDreamCommand(collectionName: string) {
  // Fetch the collection items
  const items = db.query<[number, string]>(
    `SELECT i.id, i.content
     FROM items i
     JOIN item_collections ic ON i.id = ic.item_id
     JOIN collections c ON ic.collection_id = c.id
     WHERE c.name = ?`,
    [collectionName],
  );

  if (items.length === 0) {
    console.log(`No items found in collection: ${collectionName}`);
    return;
  }

  // Parse the JSON content of each item
  const jsonItems = items.map(([id, content]) => ({
    id,
    ...JSON.parse(content),
  }));

  // Extract the shape of the JSON items
  const itemShape = await extractJsonShape(jsonItems);

  console.log("Items shape:", itemShape);

  // Generate a new item using the LLM
  const newItem = await generateNewItem(jsonItems, itemShape);

  // Print the new item and ask for user confirmation
  console.log("Generated new item:");
  console.log(JSON.stringify(newItem, null, 2));
  const confirmation = prompt(
    "Do you want to add this item to the collection? (y/n): ",
  );

  if (confirmation.toLowerCase() !== "y") {
    console.log("Item addition cancelled.");
    return;
  }

  // Add the new item to the collection
  const collectionId = await getOrCreateCollection(collectionName);
  const result = db.query(
    "INSERT INTO items (url, title, content, raw_content, source) VALUES (?, ?, ?, ?, ?) RETURNING id",
    [
      "dreamed_item",
      `Dreamed item for ${collectionName}`,
      JSON.stringify(newItem),
      JSON.stringify(newItem),
      "Dream",
    ],
  );
  const itemId = result[0][0] as number;

  await addItemToCollection(itemId, collectionName);

  console.log(
    `New item added to collection: ${collectionName} with ID: ${itemId}`,
  );
}

async function generateNewItem(items: any[], itemShape: string): Promise<any> {
  const userMessage = `Given the following array of items and their shape, generate a new item that fits within the set but contains novel ideas or data:

Items:
${JSON.stringify(items, null, 2)}

Item Shape:
${itemShape}

Generate a single new item that fits in the collection. Return only the JSON object for the new item, without any explanation or additional text.`;

  const messages: CoreMessage[] = [
    { role: "user", content: userMessage },
  ];

  console.log("Dreaming...");
  const response = await smart(messages, false);
  return response;
}

export function addDreamCommand(args: string[]) {
  if (args.length !== 1) {
    console.log("Usage: dream <COLLECTION>");
    return;
  }

  const collectionName = args[0];
  handleDreamCommand(collectionName);
}
