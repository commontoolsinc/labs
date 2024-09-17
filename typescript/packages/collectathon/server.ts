import { Application, Router, oakCors } from "./deps.ts";
import { extractEntities } from "./webpage.ts";
import { db } from "./db.ts";
import {
  getOrCreateCollection,
  listCollections,
  listItems,
  deleteCollection,
  addItemToCollection,
  removeItemFromCollection,
  moveCollection,
} from "./collections.ts";
import { clipUrl } from "./import.ts";
import { handleViewCommandSingleShot, handleViewCommandUpdate, views } from "./view.ts";
import {
  deleteItem,
  printItem,
  purge,
  editItemWeb,
  createNewItem,
} from "./items.ts";
import { addRule, applyRules, deleteRule, listRules } from "./rules.ts";
import { search } from "./search.ts";
import { handleActionCommand } from "./action.ts";
import { handleDreamCommand } from "./dream.ts";
import { handleViewCommand } from "./view.ts";
const app = new Application();
const router = new Router();

const getJsonBody = async (ctx: any) => {
  const body = ctx.request.body();
  if (body.type !== "json") {
    throw new Error("Invalid request body");
  }
  return await body.value;
};

app.use(oakCors()); // Enable CORS for all routes

router.get("/view/:collection/:viewId", (ctx) => {
  const { collection, viewId } = ctx.params;
  const result = db.query<[string]>(
    "SELECT html FROM views WHERE id = ? AND collection = ?",
    [viewId, collection]
  );

  if (result.length > 0) {
    const [html] = result[0];
    ctx.response.type = "text/html";
    ctx.response.body = html;

    // Optionally, remove the view after serving it
    // db.query("DELETE FROM views WHERE id = ?", [viewId]);
  } else {
    ctx.response.status = 404;
    ctx.response.body = "View not found";
  }
});

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
    [`${baseUrl}%`]
  );

  // If we have less than 5 suggested collections, add recent collections to fill the gap
  if (suggestedCollections.length < 5) {
    const recentCollections = db.query<[string]>(
      `SELECT DISTINCT name
       FROM collections
       WHERE name NOT IN (${suggestedCollections.map(() => '?').join(',')})
       ORDER BY id DESC
       LIMIT ?`,
      [...suggestedCollections.map(([name]) => name), 5 - suggestedCollections.length]
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

// Collection routes
router.get("/collections", async (ctx) => {
  await listCollections();
  ctx.response.body = { message: "Collections listed in console" };
});

router.delete("/collections/:name", async (ctx) => {
  const { name } = ctx.params;
  await deleteCollection(name);
  ctx.response.body = { message: `Collection ${name} deleted` };
});

router.post("/collections/:name/apply-rules", async (ctx) => {
  const { name } = ctx.params;
  await applyRules(name);
  ctx.response.body = { message: `Rules applied to collection ${name}` };
});

router.put("/collections/:name/move", async (ctx) => {
  const { name } = ctx.params;
  const { newName } = await getJsonBody(ctx);
  await moveCollection(name, newName);
  ctx.response.body = { message: `Collection ${name} moved to ${newName}` };
});

// Item routes
router.get("/collections/:name/items", async (ctx) => {
  const { name } = ctx.params;
  await listItems(name);
  ctx.response.body = { message: `Items listed for collection ${name} in console` };
});

router.get("/items/:id", (ctx) => {
  const { id } = ctx.params;
  const showRaw = ctx.request.url.searchParams.get("raw") === "true";
  printItem(parseInt(id), showRaw);
  ctx.response.body = { message: `Item ${id} printed in console` };
});

router.delete("/items/:id", (ctx) => {
  const { id } = ctx.params;
  deleteItem(parseInt(id));
  ctx.response.body = { message: `Item ${id} deleted` };
});

router.put("/items/:id", async (ctx) => {
  const { id } = ctx.params;
  const { content, raw } = await getJsonBody(ctx);
  const success = editItemWeb(parseInt(id), raw, content);
  if (success) {
    ctx.response.body = { message: `Item ${id} updated` };
  } else {
    ctx.response.status = 500;
    ctx.response.body = { error: `Failed to update item ${id}` };
  }
});

router.post("/items/:id/collections/:collection", async (ctx) => {
  const { id, collection } = ctx.params;
  await addItemToCollection(parseInt(id), collection);
  ctx.response.body = { message: `Item ${id} added to collection ${collection}` };
});

router.delete("/items/:id/collections/:collection", async (ctx) => {
  const { id, collection } = ctx.params;
  await removeItemFromCollection(parseInt(id), collection);
  ctx.response.body = { message: `Item ${id} removed from collection ${collection}` };
});

router.post("/items/purge", async (ctx) => {
  await purge();
  ctx.response.body = { message: "Purge completed" };
});

// New route for creating an item
router.post("/items", async (ctx) => {
  const { content, collections } = await getJsonBody(ctx);
  const itemId = await createNewItem(content, collections);

  if (itemId) {
    ctx.response.body = { message: `New item created with ID ${itemId}`, itemId };
  } else {
    ctx.response.status = 500;
    ctx.response.body = { error: "Failed to create new item" };
  }
});

// Rule routes
router.post("/rules", async (ctx) => {
  const { collection, rule, targetCollection } = await getJsonBody(ctx);
  await addRule(collection, rule, targetCollection);
  ctx.response.body = { message: "Rule added" };
});

router.get("/collections/:name/rules", async (ctx) => {
  const { name } = ctx.params;
  await listRules(name);
  ctx.response.body = { message: `Rules listed for collection ${name} in console` };
});

router.delete("/rules/:id", async (ctx) => {
  const { id } = ctx.params;
  await deleteRule(parseInt(id));
  ctx.response.body = { message: `Rule ${id} deleted` };
});

// Search route
router.get("/search", async (ctx) => {
  const query = ctx.request.url.searchParams.get("q");
  if (!query) {
    ctx.response.status = 400;
    ctx.response.body = { error: "Query parameter 'q' is required" };
    return;
  }
  await search(query);
  ctx.response.body = { message: "Search results printed in console" };
});

// Action route
router.post("/collections/:name/action", async (ctx) => {
  const { name } = ctx.params;
  const { prompt } = await getJsonBody(ctx);
  await handleActionCommand(name, prompt);
  ctx.response.body = { message: `Action performed on collection ${name}` };
});

// Dream route
router.post("/collections/:name/dream", async (ctx) => {
  const { name } = ctx.params;
  await handleDreamCommand(name);
  ctx.response.body = { message: `Dream generated for collection ${name}` };
});

// View routes
router.post("/collections/:name/view", async (ctx) => {
  const { name } = ctx.params;
  const { prompt } = await getJsonBody(ctx);
  const id = await handleViewCommandSingleShot(name, prompt);
  ctx.response.body = { viewId: id, message: `View generated for collection ${name}` };
});

router.put("/collections/:name/view/:viewId", async (ctx) => {
  const { name, viewId } = ctx.params;
  const { prompt } = await getJsonBody(ctx);
  await handleViewCommandUpdate(viewId, prompt);
  ctx.response.body = { viewId, message: `View updated for collection ${name}` };
});

app.use(router.routes());
app.use(router.allowedMethods());

export async function start() {
  console.log("Server running on http://localhost:8000");
  await app.listen({ port: 8000 });
}

if (import.meta.main) {
  start();
}
