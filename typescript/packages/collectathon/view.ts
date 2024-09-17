import { db } from "./db.ts";
import { chat, grabHtml } from "./llm.ts";
import { CoreMessage } from "npm:ai@3.3.21";
import { open } from "https://deno.land/x/open@v0.0.5/index.ts";

export const views = new Map<string, string>();

// 1. Interactive version
export async function handleViewCommandInteractive(collection: string, initialPrompt: string): Promise<void> {
  const items = db.query<[number, string]>(
    `SELECT i.id, i.content
     FROM items i
     JOIN item_collections ic ON i.id = ic.item_id
     JOIN collections c ON ic.collection_id = c.id
     WHERE c.name = ?`,
    [collection]
  );

  if (items.length === 0) {
    console.log(`No items found in collection: ${collection}`);
    return;
  }

  const jsonItems = items.map(([id, content]) => ({
    id,
    ...JSON.parse(content),
  }));

  let currentPrompt = initialPrompt;
  let messages: CoreMessage[] = [];

  while (true) {
    const html = await generateHTML(jsonItems, currentPrompt, messages);
    const viewId = crypto.randomUUID();

    // Store the view in the database
    db.query(
      "INSERT INTO views (id, collection, html) VALUES (?, ?, ?)",
      [viewId, collection, html]
    );

    const url = `http://localhost:8000/view/${collection}/${viewId}`;
    console.log(`Opening view in browser: ${url}`);
    await open(url);

    const nextPrompt = prompt("Enter a new prompt to regenerate the view, or type '/exit' to quit: ");

    if (nextPrompt?.toLowerCase() === '/exit') {
      console.log("Exiting view mode.");
      break;
    }

    currentPrompt = nextPrompt || currentPrompt;
  }
}

// 2. Single-shot version
export async function handleViewCommandSingleShot(collection: string, prompt: string): Promise<string> {
  const items = db.query<[number, string]>(
    `SELECT i.id, i.content
     FROM items i
     JOIN item_collections ic ON i.id = ic.item_id
     JOIN collections c ON ic.collection_id = c.id
     WHERE c.name = ?`,
    [collection]
  );

  if (items.length === 0) {
    console.log(`No items found in collection: ${collection}`);
    return "";
  }

  const jsonItems = items.map(([id, content]) => ({
    id,
    ...JSON.parse(content),
  }));

  const messages: CoreMessage[] = [];
  const html = await generateHTML(jsonItems, prompt, messages);
  const viewId = crypto.randomUUID();

  // Store the view in the database
  db.query(
    "INSERT INTO views (id, collection, html) VALUES (?, ?, ?)",
    [viewId, collection, html]
  );

  const url = `http://localhost:8000/view/${collection}/${viewId}`;
  console.log(`Opening view in browser: ${url}`);
  await open(url);

  return viewId;
}

// 3. Update existing view version
export async function handleViewCommandUpdate(viewId: string, newPrompt: string): Promise<void> {
  const view = db.query<[string, string]>(
    "SELECT collection, html FROM views WHERE id = ?",
    [viewId]
  )[0];

  if (!view) {
    console.log(`No view found with id: ${viewId}`);
    return;
  }

  const [collection, _] = view;

  const items = db.query<[number, string]>(
    `SELECT i.id, i.content
     FROM items i
     JOIN item_collections ic ON i.id = ic.item_id
     JOIN collections c ON ic.collection_id = c.id
     WHERE c.name = ?`,
    [collection]
  );

  const jsonItems = items.map(([id, content]) => ({
    id,
    ...JSON.parse(content),
  }));

  const messages: CoreMessage[] = [];
  const html = await generateHTML(jsonItems, newPrompt, messages);

  // Update the view in the database
  db.query(
    "UPDATE views SET html = ? WHERE id = ?",
    [html, viewId]
  );

  const url = `http://localhost:8000/view/${collection}/${viewId}`;
  console.log(`Updated view. Opening in browser: ${url}`);
  await open(url);
}

async function generateHTML(items: any[], prompt: string, messages: CoreMessage[]): Promise<string> {
  const systemPrompt = "You are an expert web developer. Generate a full HTML page including CSS and JavaScript to visualize the given data based on the user's prompt. You can use external libraries from CDNs if needed.";
  const userMessage = `
Generate a full HTML page to visualize this data:
${JSON.stringify(items, null, 2)}

User's visualization prompt: ${prompt}

Include all necessary HTML, CSS, and JavaScript in a single file. You can use external libraries from CDNs if needed.
`;

  if (messages.length === 0) {
    messages.push({ role: "system", content: systemPrompt });
  }
  messages.push({ role: "user", content: userMessage });

  const response = await chat(systemPrompt, messages, false);
  messages.push({ role: "assistant", content: response });
  return grabHtml(response);
}
