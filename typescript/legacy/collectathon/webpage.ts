import { getOrCreateCollection } from "./collections.ts";
import { db } from "./db.ts";
import { CID, json, sha256 } from "./deps.ts";
import { completion, fastCompletion } from "./llm.ts";
import { assert, cid, clip, jsonToFacts } from "./synopsys.ts";

export async function extractEntities(
  html: string,
  url: string,
  prompt?: string,
) {
  const systemPrompt =
    'Process the attached webpage HTML to fulfill the user\'s request. Respond only with the data extracted as an array e.g. ```json [{}, {}]``` block, no commentary.  Each object must be flat, no nested object hierarachy is permitted. Escape all quotes used within strings, e.g. `"` -> `\\"`.';
  const userPrompt = `
URL: ${url}

HTML Content:
${html}

Format the output as a JSON array of one or more objects in a \`\`\`json\`\`\ block.
${prompt ? `${prompt}` : `Extract a summary of the page as a JSON blob.`}
${prompt ? "Infer the shape of the data from the request." : `Use well-known keys for the entities from the set: ["title", "content-type" "author", "date", "content", "src", "summary", "name", "location"] but also include others to fulfill the request.`}
  `;

  const response = await completion(systemPrompt, [
    { role: "user", content: userPrompt },
  ]);

  return response;
}

export async function clipWebpage(
  url: string,
  collections: string[],
  prompt?: string,
  html?: string,
) {
  try {
    db.query("BEGIN TRANSACTION");

    if (!html) {
      console.log("fetching html");
      const response = await fetch(url);
      html = await response.text();
    } else {
      console.log("using passed html");
    }

    const entities = await extractEntities(html, url, prompt);

    let totalItemCount = 0;

    for (const entity of entities) {
      await clip(url, collections, entity);

      for (const collectionName of collections) {
        const collectionId = await getOrCreateCollection(collectionName);

        const result = db.query(
          "INSERT INTO items (url, title, content, raw_content, source) VALUES (?, ?, ?, ?, ?) RETURNING id",
          [
            url,
            `${entity.type} from ${url}`,
            JSON.stringify(entity),
            JSON.stringify(entity.content),
            "Webpage",
          ],
        );
        const itemId = result[0][0] as number;

        db.query(
          "INSERT INTO item_collections (item_id, collection_id) VALUES (?, ?)",
          [itemId, collectionId],
        );
      }
    }

    for (const collectionName of collections) {
      const itemCount = entities.length;
      console.log(
        `Clipped ${itemCount} entities from webpage to collection: ${collectionName}`,
      );
      totalItemCount += itemCount;
    }

    db.query("COMMIT");
    return entities;
  } catch (error) {
    db.query("ROLLBACK");
    console.error(`Error clipping webpage: ${error.message}`);
  }

  return [];
}
