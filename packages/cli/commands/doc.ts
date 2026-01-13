import { Command } from "@cliffy/command";
import {
  formatAsTree,
  formatSearchResults,
  formatTypeResults,
  listDocs,
  readDocContent,
  searchDocs,
  searchSimilar,
  searchTypes,
} from "../lib/doc/mod.ts";
import { render } from "../lib/render.ts";

export const doc = new Command()
  .name("doc")
  .description(
    `Search and browse Common Tools documentation.

QUICK START:
  ct doc list                      # List all docs
  ct doc list concepts             # List docs in concepts/
  ct doc search "computed cell"    # Search for terms
  ct doc similar <file.tsx>        # Find docs related to code
  ct doc type Cell                 # Search API type definitions
  ct doc show <path>               # Display a doc file`,
  )
  .default("help")
  .globalOption(
    "-B, --before <lines:number>",
    "Lines of context before match",
    { default: 2 },
  )
  .globalOption(
    "-A, --after <lines:number>",
    "Lines of context after match",
    { default: 2 },
  )
  .globalOption(
    "-C, --context <lines:number>",
    "Lines of context (sets both -A and -B)",
  )

  /* doc list */
  .command("list [subtree:string]", "List documentation files.")
  .alias("ls")
  .description(
    `List all documentation files, optionally filtered to a subtree.

Examples:
  ct doc list                   # List all docs
  ct doc list concepts          # List docs under concepts/
  ct doc list patterns          # List docs under patterns/`,
  )
  .action(async (_options, subtree?: string) => {
    const docs = await listDocs(subtree);

    if (docs.length === 0) {
      render(subtree ? `No docs found under "${subtree}".` : "No docs found.");
      return;
    }

    render(`Found ${docs.length} documentation files:\n`);
    render(formatAsTree(docs));
  })

  /* doc search */
  .command("search <query:string>", "Search documentation content.")
  .alias("s")
  .description(
    `Search through documentation content for matching terms.

Uses semantic search when a pre-built index is available,
otherwise falls back to grep-like text matching.

Examples:
  ct doc search computed          # Find docs about computed()
  ct doc search "Cell reactivity" # Search for a phrase
  ct doc search handler -C 5      # Show 5 lines of context`,
  )
  .action(async (options, query: string) => {
    const contextLines = options.context ?? undefined;
    const before = contextLines ?? options.before ?? 2;
    const after = contextLines ?? options.after ?? 2;

    const results = await searchDocs(query, { before, after });

    if (results.length === 0) {
      render(`No results for "${query}".`);
      return;
    }

    render(`Found ${results.length} matching docs:\n`);
    render(formatSearchResults(results));
  })

  /* doc similar */
  .command(
    "similar <code:string>",
    "Find documentation related to code.",
  )
  .description(
    `Analyze code and find related documentation.

Extracts identifiers and patterns from the code to find
relevant documentation. Can accept a file path or inline code.

Examples:
  ct doc similar ./mypattern.tsx         # Analyze a file
  ct doc similar "Cell.of([])"           # Analyze inline code
  ct doc similar "computed(() => ...)"   # Find computed docs`,
  )
  .action(async (options, codeOrFile: string) => {
    const contextLines = options.context ?? undefined;
    const before = contextLines ?? options.before ?? 2;
    const after = contextLines ?? options.after ?? 2;

    // Try to read as file first
    let code: string;
    try {
      code = await Deno.readTextFile(codeOrFile);
    } catch {
      // Treat as inline code
      code = codeOrFile;
    }

    const results = await searchSimilar(code, { before, after });

    if (results.length === 0) {
      render("No related documentation found.");
      return;
    }

    render(`Found ${results.length} related docs:\n`);
    render(formatSearchResults(results));
  })

  /* doc type */
  .command("type <typename:string>", "Search API type definitions.")
  .alias("t")
  .description(
    `Search the bundled type definitions for a type name or pattern.

Searches through commontools.d.ts and related type files.

Examples:
  ct doc type Cell              # Find Cell type definition
  ct doc type "IReadable"       # Find IReadable interface
  ct doc type "computed"        # Find computed function`,
  )
  .action(async (options, typename: string) => {
    const contextLines = options.context ?? undefined;
    const before = contextLines ?? options.before ?? 3;
    const after = contextLines ?? options.after ?? 3;

    const results = await searchTypes(typename, { before, after });

    if (results.length === 0) {
      render(`No type definitions found for "${typename}".`);
      return;
    }

    const totalMatches = results.reduce((sum, r) => sum + r.matches.length, 0);
    render(`Found ${totalMatches} matches in ${results.length} files:\n`);
    render(formatTypeResults(results));
  })

  /* doc show */
  .command("show <path:string>", "Display a documentation file.")
  .alias("cat")
  .description(
    `Display the contents of a documentation file.

The path can be relative to the docs root.

Examples:
  ct doc show common/concepts/computed.md
  ct doc show concepts/handler.md`,
  )
  .action(async (_options, docPath: string) => {
    try {
      // Normalize path - add common/ prefix if not present
      let normalizedPath = docPath;
      if (!docPath.startsWith("common/")) {
        normalizedPath = `common/${docPath}`;
      }

      const content = await readDocContent(normalizedPath);
      render(content);
    } catch (error) {
      render(
        `Error reading "${docPath}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      Deno.exit(1);
    }
  });
