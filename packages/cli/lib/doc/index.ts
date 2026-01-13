/**
 * Doc tree and content operations for ct doc command.
 */

import { dirname, fromFileUrl, join } from "@std/path";
import type { DocEntry, DocIndex } from "./types.ts";

// Path to bundled docs (relative to this file's location)
const BUNDLED_DOCS_PATH = join(
  dirname(fromFileUrl(import.meta.url)),
  "..",
  "..",
  "..",
  "static",
  "assets",
  "docs"
);

// Fallback: docs in repo root (for development)
const REPO_DOCS_PATH = join(
  dirname(fromFileUrl(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "docs",
  "common"
);

let cachedIndex: DocIndex | null = null;
let docsBasePath: string | null = null;

/**
 * Load the doc index, trying bundled assets first, then falling back to filesystem.
 */
export async function loadDocIndex(): Promise<DocIndex> {
  if (cachedIndex) {
    return cachedIndex;
  }

  // Try bundled index first
  const bundledIndexPath = join(BUNDLED_DOCS_PATH, "index.json");
  try {
    const content = await Deno.readTextFile(bundledIndexPath);
    cachedIndex = JSON.parse(content) as DocIndex;
    docsBasePath = BUNDLED_DOCS_PATH;
    return cachedIndex;
  } catch {
    // Fall back to building index from filesystem
  }

  // Development fallback: scan docs/common directly
  cachedIndex = await buildIndexFromFilesystem();
  docsBasePath = REPO_DOCS_PATH;
  return cachedIndex;
}

/**
 * Build a doc index by scanning the filesystem.
 * Used in development when bundled assets aren't available.
 */
async function buildIndexFromFilesystem(): Promise<DocIndex> {
  const docs: DocEntry[] = [];

  async function walk(dir: string, prefix: string): Promise<void> {
    for await (const entry of Deno.readDir(dir)) {
      const fullPath = join(dir, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.isDirectory) {
        await walk(fullPath, relativePath);
      } else if (entry.isFile && entry.name.endsWith(".md")) {
        const content = await Deno.readTextFile(fullPath);
        docs.push({
          id: relativePath.replace(/[\/\\]/g, "-").replace(/\.md$/, ""),
          path: `common/${relativePath}`,
          title: extractTitle(content, entry.name),
          headings: extractHeadings(content),
        });
      }
    }
  }

  await walk(REPO_DOCS_PATH, "");

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    docs,
  };
}

/**
 * Extract title from markdown content.
 */
function extractTitle(content: string, filename: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  if (match) {
    return match[1].trim();
  }
  return filename
    .replace(/\.md$/, "")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Extract all headings from markdown content.
 */
function extractHeadings(content: string): string[] {
  const headings: string[] = [];
  const regex = /^#{1,6}\s+(.+)$/gm;
  let match;
  while ((match = regex.exec(content)) !== null) {
    headings.push(match[1].trim());
  }
  return headings;
}

/**
 * Get the base path where doc files are stored.
 */
export async function getDocsBasePath(): Promise<string> {
  if (!docsBasePath) {
    await loadDocIndex();
  }
  return docsBasePath!;
}

/**
 * Read the content of a specific doc file.
 */
export async function readDocContent(docPath: string): Promise<string> {
  const basePath = await getDocsBasePath();

  // Handle path prefix - bundled docs have "common/" prefix, filesystem doesn't
  let fullPath: string;
  if (basePath === BUNDLED_DOCS_PATH) {
    fullPath = join(basePath, docPath);
  } else {
    // Strip "common/" prefix for filesystem access
    const relativePath = docPath.startsWith("common/")
      ? docPath.slice("common/".length)
      : docPath;
    fullPath = join(basePath, relativePath);
  }

  return await Deno.readTextFile(fullPath);
}

/**
 * List all docs, optionally filtered to a subtree.
 */
export async function listDocs(subtree?: string): Promise<DocEntry[]> {
  const index = await loadDocIndex();

  if (!subtree) {
    return index.docs;
  }

  // Normalize subtree path
  const normalizedSubtree = subtree.replace(/^\/+|\/+$/g, "");

  return index.docs.filter((doc) => {
    const docPath = doc.path.replace(/^common\//, "");
    return docPath.startsWith(normalizedSubtree + "/") ||
           docPath === normalizedSubtree ||
           docPath.startsWith(normalizedSubtree);
  });
}

/**
 * Format doc list as a tree structure.
 */
export function formatAsTree(docs: DocEntry[]): string {
  // Group by directory
  const tree: Record<string, DocEntry[]> = {};

  for (const doc of docs) {
    const dir = dirname(doc.path);
    if (!tree[dir]) {
      tree[dir] = [];
    }
    tree[dir].push(doc);
  }

  const lines: string[] = [];
  const sortedDirs = Object.keys(tree).sort();

  for (const dir of sortedDirs) {
    lines.push(dir + "/");
    const sortedDocs = tree[dir].sort((a, b) => a.path.localeCompare(b.path));
    for (let i = 0; i < sortedDocs.length; i++) {
      const doc = sortedDocs[i];
      const isLast = i === sortedDocs.length - 1;
      const prefix = isLast ? "  └── " : "  ├── ";
      const filename = doc.path.split("/").pop();
      lines.push(`${prefix}${filename}  (${doc.title})`);
    }
  }

  return lines.join("\n");
}
