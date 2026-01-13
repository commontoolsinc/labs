#!/usr/bin/env -S deno run --allow-read --allow-write
import * as path from "@std/path";
import MiniSearch from "npm:minisearch@7";

/**
 * Build script for ct doc command.
 *
 * This script:
 * 1. Walks docs/common recursively
 * 2. Extracts metadata from each markdown file
 * 3. Builds a MiniSearch index for semantic search
 * 4. Copies files to packages/static/assets/docs/
 * 5. Generates index.json and search-index.json
 *
 * Run from repo root: deno run --allow-read --allow-write packages/static/scripts/build-docs-index.ts
 */

// Configuration - easy to change later
const DOC_SOURCE_DIRS = ["docs/common"];
const ASSETS_DOCS_DIR = "packages/static/assets/docs";

interface DocMetadata {
  id: string;           // unique id (path-based)
  path: string;         // relative path from docs root (e.g., "common/concepts/computed.md")
  title: string;        // extracted from first # header or filename
  content: string;      // full text content
  codeBlocks: string;   // concatenated code blocks (for similarity search)
  headings: string[];   // all headings in the doc
}

interface DocIndex {
  version: number;
  generatedAt: string;
  docs: Array<{
    id: string;
    path: string;
    title: string;
    headings: string[];
  }>;
}

const decoder = new TextDecoder();

/**
 * Extract the title from markdown content.
 * Uses first # heading, or falls back to filename.
 */
function extractTitle(content: string, filename: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  if (match) {
    return match[1].trim();
  }
  // Fallback: convert filename to title
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
 * Extract all code blocks from markdown content.
 */
function extractCodeBlocks(content: string): string {
  const blocks: string[] = [];
  const regex = /```[\w]*\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    blocks.push(match[1]);
  }
  return blocks.join("\n");
}

/**
 * Walk a directory recursively and yield markdown files.
 */
async function* walkMarkdownFiles(
  dir: string,
  baseDir: string
): AsyncGenerator<{ fullPath: string; relativePath: string }> {
  for await (const entry of Deno.readDir(dir)) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(baseDir, fullPath);

    if (entry.isDirectory) {
      yield* walkMarkdownFiles(fullPath, baseDir);
    } else if (entry.isFile && entry.name.endsWith(".md")) {
      yield { fullPath, relativePath };
    }
  }
}

/**
 * Parse a markdown file into DocMetadata.
 */
async function parseMarkdownFile(
  fullPath: string,
  relativePath: string
): Promise<DocMetadata> {
  const content = decoder.decode(await Deno.readFile(fullPath));
  const filename = path.basename(fullPath);

  return {
    id: relativePath.replace(/[\/\\]/g, "-").replace(/\.md$/, ""),
    path: relativePath,
    title: extractTitle(content, filename),
    content: content,
    codeBlocks: extractCodeBlocks(content),
    headings: extractHeadings(content),
  };
}

/**
 * Ensure a directory exists, creating it if necessary.
 */
async function ensureDir(dir: string): Promise<void> {
  try {
    await Deno.mkdir(dir, { recursive: true });
  } catch (e) {
    if (!(e instanceof Deno.errors.AlreadyExists)) {
      throw e;
    }
  }
}

/**
 * Main build function.
 */
async function buildDocsIndex(repoRoot: string): Promise<void> {
  const allDocs: DocMetadata[] = [];
  const assetsDocsPath = path.join(repoRoot, ASSETS_DOCS_DIR);

  // Clean and recreate assets/docs directory
  try {
    await Deno.remove(assetsDocsPath, { recursive: true });
  } catch {
    // Ignore if doesn't exist
  }
  await ensureDir(assetsDocsPath);

  // Process each source directory
  for (const sourceDir of DOC_SOURCE_DIRS) {
    const sourcePath = path.join(repoRoot, sourceDir);
    const targetSubdir = path.basename(sourceDir); // e.g., "common"

    console.log(`Processing ${sourceDir}...`);

    for await (const { fullPath, relativePath } of walkMarkdownFiles(sourcePath, sourcePath)) {
      const docPath = path.join(targetSubdir, relativePath);
      const doc = await parseMarkdownFile(fullPath, docPath);
      allDocs.push(doc);

      // Copy file to assets
      const targetPath = path.join(assetsDocsPath, docPath);
      await ensureDir(path.dirname(targetPath));
      await Deno.copyFile(fullPath, targetPath);
    }
  }

  console.log(`Processed ${allDocs.length} documentation files.`);

  // Build the doc index (metadata without full content)
  const docIndex: DocIndex = {
    version: 1,
    generatedAt: new Date().toISOString(),
    docs: allDocs.map((doc) => ({
      id: doc.id,
      path: doc.path,
      title: doc.title,
      headings: doc.headings,
    })),
  };

  await Deno.writeTextFile(
    path.join(assetsDocsPath, "index.json"),
    JSON.stringify(docIndex, null, 2)
  );
  console.log("Generated index.json");

  // Build MiniSearch index
  const miniSearch = new MiniSearch({
    fields: ["title", "content", "codeBlocks", "headings"],
    storeFields: ["title", "path"],
    // Boost title and headings for better relevance
    searchOptions: {
      boost: { title: 3, headings: 2, codeBlocks: 1.5, content: 1 },
      fuzzy: 0.2,
      prefix: true,
    },
  });

  // Add documents with headings as a single string
  miniSearch.addAll(
    allDocs.map((doc) => ({
      ...doc,
      headings: doc.headings.join(" "),
    }))
  );

  // Serialize the index
  const serializedIndex = JSON.stringify(miniSearch);
  await Deno.writeTextFile(
    path.join(assetsDocsPath, "search-index.json"),
    serializedIndex
  );
  console.log("Generated search-index.json");

  // Generate the assets list for assets.ts
  const assetPaths: string[] = [
    "docs/index.json",
    "docs/search-index.json",
  ];
  for (const doc of allDocs) {
    assetPaths.push(`docs/${doc.path}`);
  }

  console.log("\nAdd these to packages/static/assets.ts:");
  console.log("---");
  for (const p of assetPaths.sort()) {
    console.log(`  "${p}",`);
  }
  console.log("---");
}

// Determine repo root (script is at packages/static/scripts/)
const scriptDir = path.dirname(path.fromFileUrl(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", "..");

buildDocsIndex(repoRoot);
