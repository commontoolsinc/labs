import { Application, Router, oakCors } from "./deps.ts";
import { extractEntities } from "./webpage.ts";
import { db } from "./db.ts";
import { getOrCreateCollection } from "./collections.ts";
import { clipUrl } from "./import.ts";
import { clip } from "./synopsys.ts";
import { start as mail } from "./mail.ts";

const app = new Application();
const router = new Router();

app.use(oakCors());

router.get("/suggested-collections", async (ctx) => {
  const currentUrl = ctx.request.url.searchParams.get("url");
  if (!currentUrl) {
    ctx.response.status = 400;
    ctx.response.body = { error: "URL parameter is required" };
    return;
  }

  const baseUrl = new URL(currentUrl).origin;

  // First, get collections containing items from the same base URL
  const suggestedCollections = db.query<[string]>(
    `SELECT DISTINCT c.name
     FROM collections c
     JOIN item_collections ic ON c.id = ic.collection_id
     JOIN items i ON ic.item_id = i.id
     WHERE i.url LIKE ?
     LIMIT 5`,
    [`${baseUrl}%`],
  );

  // If we have less than 5 suggested collections, add recent collections to fill the gap
  if (suggestedCollections.length < 5) {
    const recentCollections = db.query<[string]>(
      `SELECT DISTINCT name
       FROM collections
       WHERE name NOT IN (${suggestedCollections.map(() => "?").join(",")})
       ORDER BY id DESC
       LIMIT ?`,
      [
        ...suggestedCollections.map(([name]) => name),
        5 - suggestedCollections.length,
      ],
    );
    suggestedCollections.push(...recentCollections);
  }

  ctx.response.body = suggestedCollections.map(([name]) => name);
});

router.get("/search-collections", async (ctx) => {
  const query = ctx.request.url.searchParams.get("q");
  if (!query) {
    ctx.response.status = 400;
    ctx.response.body = { error: "Query parameter 'q' is required" };
    return;
  }
  const searchResults = db.query<[string]>(
    "SELECT name FROM collections WHERE name LIKE ? ORDER BY name LIMIT 5",
    [`%${query}%`],
  );
  ctx.response.body = searchResults.map(([name]) => name);
});

router.post("/clip", async (ctx) => {
  try {
    const body = ctx.request.body();
    if (body.type === "json") {
      const { url, collections, prompt, content } = await body.value;
      if (!url || !collections || collections.length === 0) {
        throw new Error("URL and collection are required");
      }
      console.log(
        "Clipping content:",
        content,
        "to collections:",
        collections,
        "with prompt:",
        prompt,
      );

      let entities;
      if (content.type === "webpage") {
        entities = await clipUrl(url, collections, prompt, content.html);
      } else {
        entities = await extractEntities(
          JSON.stringify(content),
          url,
          "If the provided content is already JSON then simply return it. " +
            prompt,
        );
        await saveEntities(entities, collections);
      }

      ctx.response.body = { message: "Content clipped successfully", entities };
    } else {
      throw new Error("Invalid request body");
    }
  } catch (error) {
    console.error("Error processing request:", error);
    ctx.response.status = 400;
    ctx.response.body = { error: error.message };
  }
});

async function saveEntities(entities: any[], collections: string[]) {
  const collectionIds = await Promise.all(
    collections.map((collectionName) => getOrCreateCollection(collectionName)),
  );

  for (const entity of entities) {
    const result = await db.query(
      "INSERT INTO items (url, title, content, raw_content, source) VALUES (?, ?, ?, ?, ?) RETURNING id",
      [
        entity.url || "",
        entity.title || `${entity.type} from clipped content`,
        JSON.stringify(entity),
        JSON.stringify(entity.content),
        "Clipped Content",
      ],
    );
    const itemId = result[0][0] as number;

    await clip(entity.url || "<unknown>", collections, entity);

    for (const collectionId of collectionIds) {
      await db.query(
        "INSERT INTO item_collections (item_id, collection_id) VALUES (?, ?)",
        [itemId, collectionId],
      );
    }
  }
}

app.use(router.routes());
app.use(router.allowedMethods());

export const PORT = 8001;
let server;

export async function start() {
  console.log(`Server running on http://localhost:${PORT}`);
  server = await app.listen({ port: PORT });
}

function shutdown() {
  console.log("Shutting down server...");
  if (server) {
    server.close();
    console.log("Server shut down successfully");
  }
  Deno.exit(0);
}

if (Deno) {
  Deno.addSignalListener("SIGINT", shutdown);
  Deno.addSignalListener("SIGTERM", shutdown);
}

if (import.meta.main) {
  start();
  mail();
}
