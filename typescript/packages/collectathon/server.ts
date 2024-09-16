import { Application, Router, oakCors } from "./deps.ts";
import { clipWebpage } from "./webpage.ts";
import { db } from "./db.ts";
import { getOrCreateCollection } from "./collections.ts";

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
      const { url, collection, prompt } = await body.value;
      if (!url || !collection) {
        throw new Error("URL and collection are required");
      }
      await clipWebpage(url, collection, prompt);
      ctx.response.body = { message: "URL clipped successfully" };
    } else {
      throw new Error("Invalid request body");
    }
  } catch (error) {
    console.error("Error processing request:", error);
    ctx.response.status = 400;
    ctx.response.body = { error: error.message };
  }
});

app.use(router.routes());
app.use(router.allowedMethods());

export async function start() {
  console.log("Server running on http://localhost:8000");
  await app.listen({ port: 8000 });
}
