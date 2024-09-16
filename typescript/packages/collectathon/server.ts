import { Application, Router, oakCors } from "./deps.ts";
import { extractEntities } from "./webpage.ts";
import { db } from "./db.ts";
import { getOrCreateCollection } from "./collections.ts";
import { clipUrl } from "./import.ts";

const app = new Application();
const router = new Router();

app.use(oakCors()); // Enable CORS for all routes

router.get("/recent-collections", async (ctx) => {
  const recentCollections = db.query<[string]>(
    "SELECT DISTINCT name FROM collections ORDER BY id DESC LIMIT 5"
  );
  ctx.response.body = recentCollections.map(([name]) => name);
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
    [`%${query}%`]
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
      console.log("Clipping content:", content, "to collections:", collections, "with prompt:", prompt);

      let entities;
      if (content.type === 'webpage') {
        await clipUrl(url, collections, prompt);
      } else {
        entities = await extractEntities(JSON.stringify(content), url, prompt);
        await saveEntities(entities, collections);
      }

      ctx.response.body = { message: "Content clipped successfully" };
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
  const collectionIds = await Promise.all(collections.map(collectionName => getOrCreateCollection(collectionName)));

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

export async function start() {
  console.log("Server running on http://localhost:8000");
  await app.listen({ port: 8000 });
}
