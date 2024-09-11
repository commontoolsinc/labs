import { db } from "./db.ts";
import { chat, completion } from "./llm.ts";
import {
  addItemToCollection,
  getOrCreateCollection,
  listCollections,
  listItems,
} from "./collections.ts";
import { CoreMessage } from "npm:ai@3.3.21";

export async function search(query: string) {
  const searchDate = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const collectionName = `_search_${searchDate}_${query.replace(/\s+/g, "_")}`;

  // Generate SQL query using LLM
  const sqlQuery = await generateSQLQuery(query);

  // Execute the generated SQL query
  const results = db.query(sqlQuery);

  // Create ephemeral collection
  const collectionId = getOrCreateCollection(collectionName);

  // Add search results to the ephemeral collection
  for (const [itemId] of results) {
    await addItemToCollection(itemId, collectionName, true);
  }

  await listItems(collectionName);

  console.log(`Search results saved to collection: ${collectionName}`);
  console.log(`Found ${results.length} items matching the query.`);
}

async function generateSQLQuery(userQuery: string): Promise<string> {
  const systemPrompt =
    "You are an expert in SQLite. Generate a SQLite query to search for items based on the user's query.";
  const userPrompt = `
Generate a SQLite query to search for items based on the following user query:
"${userQuery}"

Use the following table structure:
- items (id, url, title, content, raw_content, source, created_at)
- item_collections (item_id, collection_id)
- collections (id, name)

Return only the SQLite query, without any explanation or additional text.
`;

  const messages: CoreMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  const response = await chat(systemPrompt, messages);
  return response || "";
}
