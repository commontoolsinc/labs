import { getOrCreateCollection } from "./collections.ts";
import { db } from "./db.ts";
import { CID, json, sha256 } from "./deps.ts";
import { completion, fastCompletion } from "./llm.ts";
import { assert, cid, jsonToFacts } from "./synopsys.ts";

export async function extractEntities(html: string, url: string, prompt?: string) {
  const systemPrompt =
    "Extract the information the user requested from the provided webpage. You respond only with the entities extracted as JSON in a ``json``` markdown block, no commentary.";
  const userPrompt = `
Extract entities from this HTML content. Intrusctions are as follows:
${
  prompt
    ? `${prompt}`
    : `Extract:
- Media artifacts (images, videos, files) with metadata
- Meaningful paragraphs
- Table of contents
- People
- Organizations
- Locations
- A summary
- Quotes or excerpts
- Key related resources`
}


Format the output as a JSON array of objects, each with 'type', 'content' and as many other fields as appropriate.
URL: ${url}

HTML Content:
${html}
  `;

  const response = await fastCompletion(systemPrompt, [
    { role: "user", content: userPrompt },
  ]);

  return response;
}

export async function clipWebpage(
  url: string,
  collections: string[],
  prompt?: string,
) {
  try {
    db.query("BEGIN TRANSACTION");
    const response = await fetch(url);
    const html = await response.text();

    const entities = await extractEntities(html, url, prompt);

    let totalItemCount = 0;

    for (const collectionName of collections) {
      const collectionId = await getOrCreateCollection(collectionName);
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
          ],
        );
        const itemId = result[0][0] as number;

        entity["import/url"] = url;
        entity["import/source"] = "Webpage";
        entity["import/tool"] = "clipper";
        entity["import/time"] = new Date().toISOString();

        const collection = { name: collectionName, type: 'collection' };
        const collectionCid = await cid(collection);
        const entityCid = await cid(entity);

        const collectionFacts = await jsonToFacts(collection);
        const entityFacts = await jsonToFacts(entity);
        const response = await assert(...collectionFacts, ...entityFacts, [{ "/": collectionCid }, 'member', { "/": entityCid }]);
        console.log('assert', response);

        db.query(
          "INSERT INTO item_collections (item_id, collection_id) VALUES (?, ?)",
          [itemId, collectionId],
        );

        itemCount++;
      }

      console.log(
        `Clipped ${itemCount} entities from webpage to collection: ${collectionName}`,
      );
      totalItemCount += itemCount;
    }

    db.query("COMMIT");
  } catch (error) {
    db.query("ROLLBACK");
    console.error(`Error clipping webpage: ${error.message}`);
  }
}
