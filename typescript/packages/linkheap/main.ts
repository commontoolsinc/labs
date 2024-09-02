// main.ts
import { ai, open, DOMParser, Element } from "./deps.ts";
const streamText = ai.streamText;

import {
  DB,
  parse,
  readLines,
  puppeteer,
  anthropic,
  ensureDir,
} from "./deps.ts";

export const SONNET = "claude-3-5-sonnet-20240620";
const model = anthropic(SONNET);

const db = new DB("links.db");

// Create tables
db.execute(`
  CREATE TABLE IF NOT EXISTS links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT UNIQUE,
    comment TEXT,
    title TEXT,
    description TEXT,
    tags TEXT,
    category TEXT,
    summary TEXT,
    image_url TEXT,
    favicon_url TEXT,
    screenshot_path TEXT,
    html TEXT,
    json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.execute(`
  CREATE TABLE IF NOT EXISTS collections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE
  )
`);

db.execute(`
  CREATE TABLE IF NOT EXISTS link_collections (
    link_id INTEGER,
    collection_id INTEGER,
    PRIMARY KEY (link_id, collection_id),
    FOREIGN KEY (link_id) REFERENCES links(id),
    FOREIGN KEY (collection_id) REFERENCES collections(id)
  )
`);

function getOrCreateCollection(name: string): number {
  const existing = db.query("SELECT id FROM collections WHERE name = ?", [
    name,
  ]);
  if (existing.length > 0) {
    return existing[0][0] as number;
  }
  const result = db.query(
    "INSERT INTO collections (name) VALUES (?) RETURNING id",
    [name],
  );
  return result[0][0] as number;
}

async function saveLink(
  url: string,
  collections: string[],
  comment: string = "",
) {
  try {
    db.query("BEGIN TRANSACTION");

    const result = db.query(
      "INSERT INTO links (url, comment) VALUES (?, ?) RETURNING id",
      [url, comment],
    );
    const linkId = result[0][0] as number;

    for (const collectionName of collections) {
      const collectionId = getOrCreateCollection(collectionName);
      db.query(
        "INSERT INTO link_collections (link_id, collection_id) VALUES (?, ?)",
        [linkId, collectionId],
      );
    }

    db.query("COMMIT");

    console.log(`Saved link: ${url}`);
    console.log(`Collections: ${collections.join(", ")}`);
    if (comment) {
      console.log(`Comment: ${comment}`);
    }

    // Fetch and analyze the link in the background
    analyzeLink(url);
  } catch (error) {
    db.query("ROLLBACK");
    console.error(`Error saving link: ${error.message}`);
  }
}

export function grabJson(txt: string) {
  // try parsing whole string first
  try {
    return JSON.parse(txt);
  } catch (error) {
    // if that fails, try to grab it from the text
  }

  const json = txt.match(/```json\n([\s\S]+?)```/)?.[1];
  if (!json) {
    console.error("No JSON found in text", txt);
    return {};
  }
  return JSON.parse(json);
}

async function analyzeLink(
  url: string,
  comment: string = "Look at the content not the markup.",
) {
  try {
    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    console.log(`Navigating to ${url}`);
    await page.goto(url);
    console.log(`Loaded!`);

    let html = await page.content();
    const title = await page.title();
    const favicon = await page.evaluate(() => {
      const link = document.querySelector("link[rel*='icon']");
      return link ? link.href : null;
    });

    // Take a screenshot
    // Ensure screenshots directory exists
    const screenshotsDir = "views/screenshots";
    await ensureDir(screenshotsDir);

    // Take a screenshot
    const screenshotPath = `${screenshotsDir}/${Date.now()}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true });

    await browser.close();

    // Post-process HTML
    const doc = new DOMParser().parseFromString(html, "text/html");

    // Remove script tags
    doc.querySelectorAll("script").forEach((el) => (el as Element).remove());

    // Remove style tags
    doc.querySelectorAll("style").forEach((el) => (el as Element).remove());

    // Remove all class attributes
    doc
      .querySelectorAll("*")
      .forEach((el) => (el as Element).removeAttribute("class"));

    // Remove all style attributes
    doc
      .querySelectorAll("*")
      .forEach((el) => (el as Element).removeAttribute("style"));

    // Remove all on* attributes (e.g., onclick, onload, etc.)
    doc.querySelectorAll("*").forEach((el) => {
      const attributes = (el as Element).attributes;
      for (let i = attributes.length - 1; i >= 0; i--) {
        const attrName = attributes[i].name;
        if (attrName.toLowerCase().startsWith("on")) {
          (el as Element).removeAttribute(attrName);
        }
      }
    });

    // Serialize the cleaned HTML back to a string
    html = doc.documentElement?.outerHTML ?? "";

    const { textStream: analysisStream } = await streamText({
      model: model,
      system: `Analyze the following HTML content`,
      messages: [
        {
          role: "user",
          content: `Extract:
      1. 5 relevant hashtags (\`tags\`)
      2. A category for the page (\`category\`)
      3. A brief summary of the page (max 100 words) (\`summary\`)
      4. The URL of the most relevant image on the page (if any) (\`image_url\`)

      HTML Content:
      <sample>
      ${html}
      </sample>

      User instruction: ${comment}

      Provide the results in JSON format within a JSON markdown block.`,
        },
      ],
    });

    let message = "";
    for await (const delta of analysisStream) {
      message += delta;
      Deno.stdout.writeSync(new TextEncoder().encode(delta));
    }

    const analysis = grabJson(message);

    const { textStream } = await streamText({
      model: model,
      system: `take this raw HTML and convert it to structured JSON representing the data contained on the page, discard the original markup structure and imagine a new structure semantically focused on the content. Wrap the repsonse in a JSON block.
      `,
      messages: [
        {
          role: "user",
          content: ` turn this into JSON
${html}

no yapping, just output the JSON
`,
        },
      ],
    });

    message = "";
    for await (const delta of textStream) {
      message += delta;
      Deno.stdout.writeSync(new TextEncoder().encode(delta));
    }

    const structured = grabJson(message);

    // Update the database
    db.query(
      `UPDATE links SET
        title = ?, description = ?, tags = ?, category = ?,
        summary = ?, image_url = ?, favicon_url = ?, screenshot_path = ?, html = ?, json = ?
      WHERE url = ?`,
      [
        title,
        analysis.summary,
        analysis.tags.join(", "),
        analysis.category,
        analysis.summary,
        analysis.image_url,
        favicon,
        screenshotPath.replace("views/", ""),
        html,
        JSON.stringify(structured),
        url,
      ],
    );

    console.log(`Updated metadata for: ${url}`);
  } catch (error) {
    console.error(`Error analyzing link: ${error.message}`);
  }
}

async function listLinks(collection?: string) {
  if (!collection) {
    // List all collections
    const collections = db.query(`
      SELECT c.name, COUNT(lc.link_id) as link_count
      FROM collections c
      LEFT JOIN link_collections lc ON c.id = lc.collection_id
      GROUP BY c.id
      ORDER BY c.name
    `);

    console.log("Collections:");
    for (const [name, linkCount] of collections) {
      console.log(`  ${name} (${linkCount} links)`);
    }
    console.log(
      "\nUse 'list <COLLECTION>' to see details of a specific collection.",
    );
  } else {
    // List details of a specific collection
    const links = db.query(
      `
      SELECT l.*
      FROM links l
      JOIN link_collections lc ON l.id = lc.link_id
      JOIN collections c ON lc.collection_id = c.id
      WHERE c.name = ?
      ORDER BY l.created_at DESC
    `,
      [collection],
    );

    if (links.length === 0) {
      console.log(`No links found in collection: ${collection}`);
      return;
    }

    console.log(`Links in collection: ${collection}`);
    for (const [
      id,
      url,
      comment,
      title,
      description,
      tags,
      category,
      summary,
      image_url,
      favicon_url,
      screenshot_path,
      created_at,
    ] of links) {
      console.log(`\n${id}. ${url}`);
      if (comment) console.log(`   Comment: ${comment}`);
      console.log(`   Title: ${title || "N/A"}`);
      console.log(`   Description: ${description || "N/A"}`);
      console.log(`   Tags: ${tags || "N/A"}`);
      console.log(`   Category: ${category || "N/A"}`);
      console.log(`   Summary: ${summary || "N/A"}`);
      console.log(`   Image URL: ${image_url || "N/A"}`);
      console.log(`   Favicon URL: ${favicon_url || "N/A"}`);
      console.log(`   Screenshot: ${screenshot_path || "N/A"}`);
      console.log(`   Created at: ${created_at}`);
    }
  }
}

async function viewCollection(collection: string, comment?: string) {
  try {
    // Ensure views directory exists
    const viewsDir = "views";
    await ensureDir(viewsDir);

    // Fetch links for the given collection
    const links = db.query(
      `
      SELECT l.*
      FROM links l
      JOIN link_collections lc ON l.id = lc.link_id
      JOIN collections c ON lc.collection_id = c.id
      WHERE c.name = ?
      ORDER BY l.created_at DESC
    `,
      [collection],
    );

    // Generate HTML content
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `${collection}_${timestamp}.html`;
    const filePath = `${viewsDir}/${fileName}`;

    let htmlContent = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Collection: ${collection}</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        table { border-collapse: collapse; width: 100%; }
        th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
        th { background-color: #f2f2f2; }
        img { max-width: 200px; max-height: 200px; }
      </style>
    </head>
    <body>
      <h1>Collection: ${collection}</h1>
      ${comment ? `<p><em>${comment}</em></p>` : ""}
      <table>
        <tr>
          <th>Title</th>
          <th>URL</th>
          <th>Category</th>
          <th>Comment</th>
          <th>Summary</th>
          <th>Tags</th>
          <th>Screenshot</th>
          <th>Image</th>
        </tr>
    `;

    for (const [
      id,
      url,
      linkComment,
      title,
      ,
      tags,
      category,
      summary,
      image_url,
      ,
      screenshot_path,
    ] of links) {
      htmlContent += `
        <tr>
          <td>${title || "N/A"}</td>
          <td><a href="${url}" target="_blank">${url}</a></td>
          <td>${category || "N/A"}</td>
          <td>${linkComment || "N/A"}</td>
          <td>${summary || "N/A"}</td>
          <td>${tags || "N/A"}</td>
          <td>${screenshot_path ? `<img src="${screenshot_path}" alt="Screenshot">` : "N/A"}</td>
          <td>${image_url ? `<img src="${image_url}" alt="Image">` : "N/A"}</td>
        </tr>
      `;
    }

    htmlContent += `
      </table>
    </body>
    </html>
    `;

    // Write HTML content to file
    await Deno.writeTextFile(filePath, htmlContent);

    console.log(`View saved to: ${filePath}`);

    // Open the HTML file in the default web browser
    await open(filePath);
  } catch (error) {
    console.error(`Error viewing collection: ${error.message}`);
  }
}

async function imagineCollection(collection: string, userComment?: string) {
  try {
    // Ensure views directory exists
    const viewsDir = "views";
    await ensureDir(viewsDir);

    // Fetch links for the given collection
    const links = db.query(
      `
      SELECT l.*
      FROM links l
      JOIN link_collections lc ON l.id = lc.link_id
      JOIN collections c ON lc.collection_id = c.id
      WHERE c.name = ?
      ORDER BY l.created_at DESC
    `,
      [collection],
    );

    if (links.length === 0) {
      console.log(`No links found in collection: ${collection}`);
      return;
    }

    // Prepare data for LLM query
    const linksData = links.map(
      ([
        id,
        url,
        comment,
        title,
        description,
        tags,
        category,
        summary,
        image_url,
        favicon_url,
        screenshot_path,
        created_at,
        json,
      ]) => ({
        url,
        comment,
        title,
        description,
        tags,
        category,
        image_url,
        favicon_url,
        screenshot_path,
        created_at,
        json,
      }),
    );

    const prompt = `
    Take this collections of links and imagine an interactive webpage. The collection is named "${collection}" and contains ${links.length} links. Here's the data:

${JSON.stringify(linksData, null, 2).slice(0, 50000)}

Create a complete HTML page that inspired by this collection. Try to synthesize the broader themes of this collection and capture them in the artifact.

${userComment ? `User's comment: ${userComment}` : ""}

Provide the entire HTML code for the page, including any embedded CSS and JavaScript.
`;

    console.log("Sending prompt to LLM...");

    const { textStream, finishReason } = await streamText({
      model: model,
      system: `You are an expert web developer who creates innovative and engaging HTML pages.`,
      messages: [{ role: "user", content: prompt }],
    });

    let htmlContent = "";
    for await (const delta of textStream) {
      htmlContent += delta;
      Deno.stdout.writeSync(new TextEncoder().encode(delta));
    }

    const reason = await finishReason;

    // Extract HTML content from the LLM response
    const htmlMatch = htmlContent.match(/<html[\s\S]*<\/html>/i);
    if (!htmlMatch) {
      console.error("No valid HTML found in LLM response");
      return;
    }

    const finalHtml = htmlMatch[0];

    // Generate file name and path
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `${collection}_imagined_${timestamp}.html`;
    const filePath = `${viewsDir}/${fileName}`;

    // Write HTML content to file
    await Deno.writeTextFile(filePath, finalHtml);

    console.log(`Imagined view saved to: ${filePath}`);

    // Open the HTML file in the default web browser
    await open(filePath);
  } catch (error) {
    console.error(`Error imagining collection: ${error.message}`);
  }
}

async function main() {
  console.log("Welcome to the Link Saver CLI!");
  console.log("Available commands:");
  console.log(
    "  save <URL> [collection1 collection2 ...] [--comment <COMMENT>]",
  );
  console.log("  list [<COLLECTION>]");
  console.log("  view <COLLECTION> [<COMMENT>]");
  console.log("  imagine <COLLECTION> [<COMMENT>]");
  console.log("  refresh <URL>");
  console.log("  exit");

  for await (const line of readLines(Deno.stdin)) {
    const args = line.trim().split(" ");
    const command = args.shift()?.toLowerCase();

    switch (command) {
      case "save":
        if (args.length === 0) {
          console.log("Please provide a URL to save.");
        } else {
          const url = args.shift()!;
          const commentIndex = args.indexOf("--comment");
          let collections: string[] = [];
          let comment: string = "";

          if (commentIndex !== -1) {
            collections = args.slice(0, commentIndex);
            comment = args.slice(commentIndex + 1).join(" ");
          } else {
            collections = args;
          }

          await saveLink(url, collections, comment);
        }
        break;
      case "list":
        await listLinks(args[0]);
        break;
      case "view":
        if (args.length === 0) {
          console.log("Please provide a collection name to view.");
        } else {
          const collection = args.shift()!;
          const comment = args.join(" ");
          await viewCollection(collection, comment);
        }
        break;
      case "imagine":
        if (args.length === 0) {
          console.log("Please provide a collection name to imagine.");
        } else {
          const collection = args.shift()!;
          const comment = args.join(" ");
          await imagineCollection(collection, comment);
        }
        break;
      case "refresh":
        if (args.length === 0) {
          console.log("Please provide a URL to refresh.");
        } else {
          const url = args[0];
          await analyzeLink(url);
        }
        break;

      case "exit":
        console.log("Goodbye!");
        Deno.exit(0);
      default:
        console.log("Unknown command. Available commands:");
        console.log(
          "  save <URL> [collection1 collection2 ...] [--comment <COMMENT>]",
        );
        console.log("  list [<COLLECTION>]");
        console.log("  view <COLLECTION> [<COMMENT>]");
        console.log("  imagine <COLLECTION> [<COMMENT>]");
        console.log("  refresh <URL>");
        console.log("  exit");
    }
  }
}

if (import.meta.main) {
  main();
}
