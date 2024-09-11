import { getOrCreateCollection } from "./collections.ts";
import { db } from "./db.ts";
import { ensureDir, walk } from "./deps.ts";

export async function runCommand(cmd: string[], cwd?: string): Promise<string> {
  const command = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd,
    stdout: "piped",
    stderr: "piped",
  });

  const { code, stdout, stderr } = await command.output();

  if (code === 0) {
    return new TextDecoder().decode(stdout).trim();
  } else {
    const errorString = new TextDecoder().decode(stderr);
    throw new Error(errorString);
  }
}

export async function clipGitHub(url: string, collectionName: string) {
  try {
    const repoPath = new URL(url).pathname.split("/").slice(-2).join("/");
    const localPath = `./temp/${repoPath}`;

    await ensureDir("./temp");

    console.log(`Cloning repository: ${url}`);
    await runCommand(["git", "clone", url, localPath]);

    db.query("BEGIN TRANSACTION");

    const collectionId = await getOrCreateCollection(collectionName);
    let itemCount = 0;

    for await (const entry of walk(localPath, { includeDirs: false })) {
      // Skip the .git folder and its contents
      if (entry.path.includes("/.git/")) {
        continue;
      }

      const relativePath = entry.path.replace(localPath + "/", "");
      const content = await Deno.readTextFile(entry.path);

      const contentJson = {
        path: relativePath,
        content: content,
      };

      const result = db.query(
        "INSERT INTO items (url, title, content, raw_content, source) VALUES (?, ?, ?, ?, ?) RETURNING id",
        [
          `${url}/blob/main/${relativePath}`,
          relativePath,
          JSON.stringify(contentJson),
          content,
          "GitHub",
        ],
      );
      const itemId = result[0][0] as number;

      db.query(
        "INSERT INTO item_collections (item_id, collection_id) VALUES (?, ?)",
        [itemId, collectionId],
      );

      itemCount++;
    }

    db.query("COMMIT");

    console.log(
      `Clipped ${itemCount} files from GitHub repository to collection: ${collectionName}`,
    );

    // Clean up: remove the cloned repository
    await Deno.remove(localPath, { recursive: true });
  } catch (error) {
    db.query("ROLLBACK");
    console.error(`Error clipping GitHub repository: ${error.message}`);
  }
}
