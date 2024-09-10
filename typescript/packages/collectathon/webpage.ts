import { getOrCreateCollection } from "./collections.ts";
import { db } from "./db.ts";
import { completion } from "./llm.ts";

async function extractEntities(html: string, url: string, prompt?: string) {
  const systemPrompt =
    "You are an expert at extracting structured data from web pages. You respond only with the entities extracted, no commentary.";
  const userPrompt = `
Extract entities from this HTML content. Include:
${
  prompt
    ? `User instruction: ${prompt}`
    : `- Media artifacts (images, videos, files) with metadata
- Paragraphs
- People
- Messages
- Objects
- Ideas
- Places
- Links to other resources
- Any other relevant entities`
}


Format the output as a JSON array of objects, each with 'type', 'content' and as many other fields as appropriate.
URL: ${url}

HTML Content:
${html}
  `;

  const response = await completion(systemPrompt, [
    { role: "user", content: userPrompt },
  ]);

  return response;
}

export async function clipWebpage(
  url: string,
  collectionName: string,
  prompt?: string
) {
  try {
    db.query("BEGIN TRANSACTION");
    const response = await fetch(url);
    const html = await response.text();

    const entities = await extractEntities(html, url, prompt);

    const collectionId = getOrCreateCollection(collectionName);
    let itemCount = 0;

    for (const entity of entities) {
      const result = db.query(
        "INSERT INTO items (url, title, content, raw_content, source) VALUES (?, ?, ?, ?, ?) RETURNING id",
        [
          url,
          `${entity.type} from ${url}`,
          JSON.stringify(entity),
          JSON.stringify(entity.content),
          "Webpage",
        ]
      );
      const itemId = result[0][0] as number;

      db.query(
        "INSERT INTO item_collections (item_id, collection_id) VALUES (?, ?)",
        [itemId, collectionId]
      );

      itemCount++;
    }

    db.query("COMMIT");

    console.log(
      `Clipped ${itemCount} entities from webpage to collection: ${collectionName}`
    );
  } catch (error) {
    db.query("ROLLBACK");
    console.error(`Error clipping webpage: ${error.message}`);
  }
}
