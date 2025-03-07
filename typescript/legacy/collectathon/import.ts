import { db } from "./db.ts";
import { walk, ensureDir } from "./deps.ts";
import { getOrCreateCollection } from "./collections.ts";
import { clipGitHub, syncGitHubIssues } from "./github.ts";
import { clipCalendar } from "./calendar.ts";
import { clipRSS } from "./rss.ts";
import { clipWebpage } from "./webpage.ts";

export async function clipUrl(
  url: string,
  collections: string[],
  prompt: string | undefined,
  htmlSource: string | undefined,
) {
  if (url.endsWith(".ics")) {
    await clipCalendar(url, collections);
  } else if (url.includes("github.com")) {
    if (url.includes("issues")) {
      await syncGitHubIssues(url, collections);
    } else {
      await clipGitHub(url, collections);
    }
  } else if (
    url.includes(".rss") ||
    url.includes("/RSS") ||
    url.includes("/feed") ||
    url.includes("feedformat=")
  ) {
    await clipRSS(url, collections);
  } else {
    return await clipWebpage(url, collections, prompt, htmlSource);
  }

  return [];
}

export async function importFiles(
  path: string,
  collectionName: string,
  fileTypeFilter: string = "*",
) {
  try {
    const fullPath = await Deno.realPath(path);
    const fileInfo = await Deno.stat(fullPath);

    db.query("BEGIN TRANSACTION");

    const collectionId = await getOrCreateCollection(collectionName);
    let itemCount = 0;
    let updatedCount = 0;

    const gitignorePattern = await getGitignorePattern(fullPath);

    if (fileInfo.isDirectory) {
      for await (const entry of walk(fullPath, {
        includeDirs: false,
        match: [new RegExp(fileTypeFilter.replace("*", ".*"))],
        skip: [/node_modules/, /\.git/, ...gitignorePattern],
      })) {
        const result = await processFile(entry.path, collectionId, fullPath);
        if (result === "updated") {
          updatedCount++;
        } else {
          itemCount++;
        }
      }
    } else {
      if (
        fileTypeFilter === "*" ||
        fullPath.endsWith(fileTypeFilter.replace("*", ""))
      ) {
        if (!isIgnoredFile(fullPath, gitignorePattern)) {
          const result = await processFile(fullPath, collectionId, Deno.cwd());
          if (result === "updated") {
            updatedCount++;
          } else {
            itemCount++;
          }
        }
      }
    }

    db.query("COMMIT");

    console.log(
      `Imported ${itemCount} new file(s) and updated ${updatedCount} existing file(s) in collection: ${collectionName}`,
    );
  } catch (error) {
    console.error(`Error importing files: ${error.message}`);
    db.query("ROLLBACK");
  }
}

async function getGitignorePattern(path: string): Promise<RegExp[]> {
  try {
    const gitignorePath = `${path}/.gitignore`;
    const content = await Deno.readTextFile(gitignorePath);
    return content
      .split("\n")
      .filter((line) => line.trim() && !line.startsWith("#"))
      .map((pattern) => new RegExp(pattern.replace(/\*/g, ".*")));
  } catch {
    return [];
  }
}

function isIgnoredFile(filePath: string, gitignorePattern: RegExp[]): boolean {
  return gitignorePattern.some((pattern) => pattern.test(filePath));
}

async function processFile(
  filePath: string,
  collectionId: number,
  basePath: string,
): Promise<"new" | "updated"> {
  const relativePath = filePath.replace(basePath, "").replace(/^\//, "");
  const content = await Deno.readTextFile(filePath);
  const fileUrl = `file://${filePath}`;

  const contentJson = {
    path: relativePath,
    content: content,
  };

  // Check if the file already exists in the database
  const existingItem = await db.query<[number]>(
    "SELECT id FROM items WHERE url = ?",
    [fileUrl],
  );

  if (existingItem.length > 0) {
    // Update existing record
    const itemId = existingItem[0][0];
    await db.query(
      "UPDATE items SET title = ?, content = ?, raw_content = ? WHERE id = ?",
      [relativePath, JSON.stringify(contentJson), content, itemId],
    );

    // Ensure the item is associated with the current collection
    await db.query(
      "INSERT OR IGNORE INTO item_collections (item_id, collection_id) VALUES (?, ?)",
      [itemId, collectionId],
    );

    return "updated";
  } else {
    // Insert new record
    const result = await db.query(
      "INSERT INTO items (url, title, content, raw_content, source) VALUES (?, ?, ?, ?, ?) RETURNING id",
      [
        fileUrl,
        relativePath,
        JSON.stringify(contentJson),
        content,
        "Local File",
      ],
    );
    const itemId = result[0][0] as number;

    await db.query(
      "INSERT INTO item_collections (item_id, collection_id) VALUES (?, ?)",
      [itemId, collectionId],
    );

    return "new";
  }
}
