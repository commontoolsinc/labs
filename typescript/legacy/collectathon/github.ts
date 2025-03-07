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

export async function clipGitHub(url: string, collections: string[]) {
  try {
    db.query("BEGIN TRANSACTION");
    const repoPath = new URL(url).pathname.split("/").slice(-2).join("/");
    const localPath = `./temp/${repoPath}`;

    await ensureDir("./temp");

    console.log(`Cloning repository: ${url}`);
    await runCommand(["git", "clone", url, localPath]);

    const collectionIds = await Promise.all(collections.map(collectionName => getOrCreateCollection(collectionName)));
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

      const result = await db.query(
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

      for (const collectionId of collectionIds) {
        await db.query(
          "INSERT INTO item_collections (item_id, collection_id) VALUES (?, ?)",
          [itemId, collectionId],
        );
      }

      itemCount++;
    }

    console.log(
      `Clipped ${itemCount} files from GitHub repository to collection: ${collections.join(', ')}`,
    );

    // Clean up: remove the cloned repository
    await Deno.remove(localPath, { recursive: true });

    db.query("COMMIT");
  } catch (error) {
    console.error(`Error clipping GitHub repository: ${error.message}`);
    db.query("ROLLBACK");
  }
}

export async function syncGitHubIssues(repoUrl: string, collections: string[]) {
  try {
    db.query("BEGIN TRANSACTION");
    // Update URL parsing logic
    const urlParts = new URL(repoUrl).pathname.split("/").filter(Boolean);
    const owner = urlParts[0];
    const repo = urlParts[1];
    if (!owner || !repo) {
      throw new Error("Invalid GitHub repository URL");
    }
    let apiUrl = `https://api.github.com/repos/${owner}/${repo}/issues?state=all&per_page=100`;
    let itemCountProcessed = 0;

    while (apiUrl) {
      const response = await fetch(apiUrl, {
        headers: {
          "Accept": "application/vnd.github.v3+json",
          "User-Agent": "Collectathon",
        },
      });

      if (!response.ok) {
        throw new Error(`GitHub API request failed: ${response.statusText}`);
      }

      const issues = await response.json();
      const collectionIds = await Promise.all(collections.map(collectionName => getOrCreateCollection(collectionName)));

      for (const issue of issues) {
        const contentJson = {
          number: issue.number,
          title: issue.title,
          state: issue.state,
          created_at: issue.created_at,
          updated_at: issue.updated_at,
          body: issue.body || "",
          html_url: issue.html_url,
          user: issue.user.login,
          labels: issue.labels.map((label: any) => label.name).join(', '),
        };

        const result = await db.query(
          "INSERT INTO items (url, title, content, raw_content, source) VALUES (?, ?, ?, ?, ?) RETURNING id",
          [
            issue.html_url,
            `Issue #${issue.number}: ${issue.title}`,
            JSON.stringify(contentJson),
            issue.body || "(empty)",
            "GitHub Issue",
          ],
        );
        const itemId = result[0][0] as number;

        for (const collectionId of collectionIds) {
          await db.query(
            "INSERT INTO item_collections (item_id, collection_id) VALUES (?, ?)",
            [itemId, collectionId],
          );
        }

        itemCountProcessed++;
      }

      // Check for next page
      const linkHeader = response.headers.get('Link');
      apiUrl = getNextPageUrl(linkHeader);
    }

    console.log(
      `Synced ${itemCountProcessed} issues from GitHub repository to collections: ${collections.join(', ')}`,
    );

    db.query("COMMIT");
  } catch (error) {
    console.error(`Error syncing GitHub issues: ${error.message}`);
    db.query("ROLLBACK");
  }
}

function getNextPageUrl(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const links = linkHeader.split(',');
  const nextLink = links.find(link => link.includes('rel="next"'));
  if (!nextLink) return null;
  const match = nextLink.match(/<(.+)>/);
  return match ? match[1] : null;
}
