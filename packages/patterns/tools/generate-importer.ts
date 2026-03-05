#!/usr/bin/env -S deno run -A
/**
 * generate-importer.ts — CLI tool that orchestrates the full importer
 * generation pipeline:
 *
 *   fetch OpenAPI spec → extract provider config + API info → generate prompt
 *   → call Claude API → write output files
 *
 * Usage:
 *   deno run -A packages/patterns/tools/generate-importer.ts \
 *     --spec https://api.example.com/openapi.json \
 *     --provider notion \
 *     --brand-color "#000000" \
 *     --output-dir packages/patterns/notion
 *
 * Flags:
 *   --spec         URL or file path to an OpenAPI 3.x JSON spec (required)
 *   --provider     Lowercase provider slug, e.g. "notion" (required)
 *   --brand-color  Hex color for branding, e.g. "#000000" (default: "#333333")
 *   --output-dir   Directory to write generated files into (required)
 *   --dry-run      Print the prompt to stdout instead of calling Claude
 *   --prompt-only  Write the prompt to {output-dir}/prompt.txt
 *   --help         Show usage information
 *
 * @module
 */

import { parseArgs } from "@std/cli/parse-args";
import {
  extractProviderConfig,
  generateDescriptorSource,
} from "./openapi-to-provider.ts";
import { extractAPI } from "./openapi-extract.ts";
import { generateImporterPrompt } from "./importer-prompt.ts";
import { toPascalCase } from "./openapi-utils.ts";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `
generate-importer — Generate a full Common Tools importer from an OpenAPI spec

USAGE:
  deno run -A packages/patterns/tools/generate-importer.ts [OPTIONS]

REQUIRED:
  --spec <url|path>      URL or file path to an OpenAPI 3.x JSON spec
  --provider <name>      Lowercase provider slug (e.g. "notion")
  --output-dir <path>    Directory to write generated files into

OPTIONS:
  --brand-color <hex>    Hex color for branding (default: "#333333")
  --dry-run              Print the prompt to stdout; do not call Claude
  --prompt-only          Write the prompt to {output-dir}/prompt.txt
  --help                 Show this message
`.trim();

async function main() {
  const args = parseArgs(Deno.args, {
    string: ["spec", "provider", "brand-color", "output-dir"],
    boolean: ["dry-run", "prompt-only", "help"],
    default: {
      "brand-color": "#333333",
    },
  });

  if (args.help) {
    console.log(USAGE);
    Deno.exit(0);
  }

  // Validate required args
  if (!args.spec) {
    console.error(
      "Error: --spec is required (URL or file path to OpenAPI spec)",
    );
    console.error("Run with --help for usage.");
    Deno.exit(1);
  }
  if (!args.provider) {
    console.error("Error: --provider is required (e.g. 'notion')");
    console.error("Run with --help for usage.");
    Deno.exit(1);
  }
  if (!args["output-dir"]) {
    console.error("Error: --output-dir is required");
    console.error("Run with --help for usage.");
    Deno.exit(1);
  }

  const specSource = args.spec;
  const providerName = args.provider;
  const brandColor = args["brand-color"]!;
  const outputDir = args["output-dir"];
  const dryRun = args["dry-run"] ?? false;
  const promptOnly = args["prompt-only"] ?? false;

  // -------------------------------------------------------------------------
  // 1. Fetch / load the OpenAPI spec
  // -------------------------------------------------------------------------
  console.log(`\n→ Loading OpenAPI spec from: ${specSource}`);

  let specText: string;
  if (specSource.startsWith("http://") || specSource.startsWith("https://")) {
    const response = await fetch(specSource);
    if (!response.ok) {
      console.error(
        `Error: Failed to fetch spec: ${response.status} ${response.statusText}`,
      );
      Deno.exit(1);
    }
    specText = await response.text();
  } else {
    try {
      specText = await Deno.readTextFile(specSource);
    } catch (err) {
      console.error(`Error: Could not read spec file: ${specSource}`);
      console.error((err as Error).message);
      Deno.exit(1);
    }
  }

  let spec: Record<string, unknown>;
  try {
    spec = JSON.parse(specText);
  } catch {
    console.error("Error: Spec is not valid JSON.");
    Deno.exit(1);
  }

  // -------------------------------------------------------------------------
  // 2. Extract provider config
  // -------------------------------------------------------------------------
  console.log(`→ Extracting provider config for "${providerName}"...`);
  const providerConfig = extractProviderConfig(spec, providerName);
  console.log(
    `  Auth type: ${providerConfig.securitySchemeType}` +
      (providerConfig.oauthFlowType
        ? ` (${providerConfig.oauthFlowType})`
        : "") +
      `, scopes: ${Object.keys(providerConfig.scopes).length}`,
  );

  // -------------------------------------------------------------------------
  // 3. Extract API info
  // -------------------------------------------------------------------------
  console.log(`→ Extracting API info...`);
  const api = extractAPI(spec);
  console.log(`  Found ${api.endpoints.length} endpoints`);
  if (api.pagination) {
    console.log(
      `  Pagination: ${api.pagination.style}` +
        (api.pagination.requestParam
          ? ` (param: ${api.pagination.requestParam})`
          : ""),
    );
  }

  // -------------------------------------------------------------------------
  // 4. Generate prompt
  // -------------------------------------------------------------------------
  console.log(`→ Generating prompt...`);
  const prompt = generateImporterPrompt({
    providerName,
    brandColor,
    api,
    providerConfig,
  });
  console.log(`  Prompt length: ${prompt.length} characters`);

  // -------------------------------------------------------------------------
  // 5. Check prompt size limits
  // -------------------------------------------------------------------------
  if (prompt.length > 400_000) {
    console.error(
      `Error: Prompt is ${prompt.length.toLocaleString()} characters (~${
        Math.round(prompt.length / 4)
          .toLocaleString()
      } tokens), which exceeds the 400K character limit.\n` +
        "The spec is too large. Reduce it by filtering endpoints or removing\n" +
        "unused schemas before re-running.",
    );
    Deno.exit(1);
  }
  if (prompt.length > 100_000) {
    console.warn(
      `\n⚠ WARNING: Prompt is ${prompt.length.toLocaleString()} characters (~${
        Math.round(prompt.length / 4)
          .toLocaleString()
      } tokens).\n` +
        "  Large prompts may produce lower quality results or hit token limits.\n" +
        "  Consider using --dry-run to inspect the prompt, or reducing the spec.\n",
    );
  }

  // -------------------------------------------------------------------------
  // 6. Handle --dry-run / --prompt-only
  // -------------------------------------------------------------------------
  if (dryRun) {
    console.log("\n--- DRY RUN: Prompt follows ---\n");
    console.log(prompt);
    Deno.exit(0);
  }

  if (promptOnly) {
    await Deno.mkdir(outputDir, { recursive: true });
    const promptPath = `${outputDir}/prompt.txt`;
    await Deno.writeTextFile(promptPath, prompt);
    console.log(`\n✓ Prompt written to ${promptPath}`);
    Deno.exit(0);
  }

  // -------------------------------------------------------------------------
  // 7. Call Claude API
  // -------------------------------------------------------------------------
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    console.error(
      "Error: ANTHROPIC_API_KEY environment variable is not set.\n" +
        "Set it before running, or use --dry-run / --prompt-only to skip the API call.",
    );
    Deno.exit(1);
  }

  console.log(`→ Calling Claude API (claude-sonnet-4-20250514)...`);

  // Dynamic import so the tool doesn't fail at load time if the SDK isn't cached
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey });

  // deno-lint-ignore no-explicit-any
  let message: any;
  try {
    message = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 64000,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    });
  } catch (err) {
    console.error(
      "Error: Claude API call failed.\n" +
        `  ${(err as Error).message}\n` +
        "Check your ANTHROPIC_API_KEY and network connection, or use --dry-run / --prompt-only.",
    );
    Deno.exit(1);
  }

  if (message.stop_reason === "max_tokens") {
    console.warn(
      "\n⚠ WARNING: Claude's response was truncated (hit max_tokens limit).\n" +
        "  The generated files may be incomplete. Consider reducing the spec\n" +
        "  (e.g. filter endpoints) or splitting the generation into multiple runs.\n",
    );
  }

  // Extract text from the response
  const responseText = message.content
    .filter((block: { type: string }) => block.type === "text")
    .map((block: { type: string; text?: string }) =>
      "text" in block ? block.text : ""
    )
    .join("\n");

  console.log(
    `  Response received (${responseText.length} chars, ${
      message.usage?.output_tokens ?? "?"
    } tokens)`,
  );

  // -------------------------------------------------------------------------
  // 8. Parse response into files
  // -------------------------------------------------------------------------
  console.log(`→ Parsing generated files...`);
  const files = parseGeneratedFiles(responseText, providerName);

  if (files.size === 0) {
    console.error(
      "Error: Could not parse any files from Claude's response.\n" +
        "The response may not contain properly fenced code blocks.\n" +
        "Try --prompt-only and submit the prompt manually.",
    );
    // Write the raw response for debugging
    await Deno.mkdir(outputDir, { recursive: true });
    await Deno.writeTextFile(`${outputDir}/raw-response.txt`, responseText);
    console.error(`Raw response saved to ${outputDir}/raw-response.txt`);
    Deno.exit(1);
  }

  // -------------------------------------------------------------------------
  // 9. Generate descriptor source (server-side)
  // -------------------------------------------------------------------------
  const descriptorSource = generateDescriptorSource(providerConfig);
  files.set(`${providerName}.descriptor.ts`, descriptorSource);

  // -------------------------------------------------------------------------
  // 10. Write output files
  // -------------------------------------------------------------------------
  console.log(`→ Writing ${files.size} files to ${outputDir}/...`);
  await Deno.mkdir(outputDir, { recursive: true });

  for (const [filename, content] of files) {
    const filePath = `${outputDir}/${filename}`;

    // Ensure subdirectories exist (e.g. util/)
    const dir = filePath.substring(0, filePath.lastIndexOf("/"));
    if (dir) {
      await Deno.mkdir(dir, { recursive: true });
    }

    await Deno.writeTextFile(filePath, content);
    console.log(`  wrote ${filePath}`);
  }

  // -------------------------------------------------------------------------
  // 11. Summary
  // -------------------------------------------------------------------------
  const pascal = toPascalCase(providerName);

  console.log(`
Done! Generated ${files.size} files for the "${providerName}" importer.

Next steps:
  1. Review the generated files in ${outputDir}/
  2. Copy ${providerName}.descriptor.ts to packages/toolshed/routes/integrations/${providerName}/
  3. Add ${pascal.toUpperCase()}_CLIENT_ID and ${pascal.toUpperCase()}_CLIENT_SECRET to packages/toolshed/.env
  4. Register the OAuth route in packages/toolshed/routes/integrations/
  5. Deploy the patterns:
       cd ../labs && CT_API_URL=http://localhost:8000 deno task ct piece new ${outputDir}/${providerName}-auth.tsx -s <space>
       cd ../labs && CT_API_URL=http://localhost:8000 deno task ct piece new ${outputDir}/${providerName}-importer.tsx -s <space>
  6. Test the OAuth flow and importer in the shell
`);
}

// ---------------------------------------------------------------------------
// Response parser
// ---------------------------------------------------------------------------

/**
 * Parse Claude's response text to extract generated files from fenced code
 * blocks. Expects blocks like:
 *
 * ```typescript
 * // provider-auth.tsx
 * ... code ...
 * ```
 *
 * or with the filename on the info line:
 *
 * ```typescript:provider-auth.tsx
 * ... code ...
 * ```
 */
function parseGeneratedFiles(
  response: string,
  providerName: string,
): Map<string, string> {
  const files = new Map<string, string>();

  // Match fenced code blocks: ```lang or ```lang:filename (case-insensitive),
  // also handles bare ``` blocks as a fallback
  const blockRegex =
    /```(?:typescript|tsx?|ts)?(?::([^\n]+))?\n([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;

  while ((match = blockRegex.exec(response)) !== null) {
    const infoFilename = match[1]?.trim();
    const code = match[2];

    // Try to get filename from the info string first
    let filename = infoFilename;

    // Otherwise look for a comment on the first line: // filename.tsx
    if (!filename) {
      const firstLine = code.split("\n")[0]?.trim() ?? "";
      const commentMatch = firstLine.match(
        /^\/\/\s*((?:[\w-]+\/)*[\w-]+\.tsx?)/,
      );
      if (commentMatch) {
        filename = commentMatch[1];
      }
    }

    if (!filename) continue;

    // Normalize: strip leading path components that duplicate the provider name
    filename = filename.replace(/^.*?(?=(?:[\w-]+\/)*[\w-]+\.tsx?$)/, "");

    // If the code block had a filename comment as the first line, strip it
    // from the content to avoid duplication
    let content = code;
    const firstLine = content.split("\n")[0]?.trim() ?? "";
    if (firstLine.match(/^\/\/\s*(?:[\w-]+\/)*[\w-]+\.tsx?\s*$/)) {
      content = content.split("\n").slice(1).join("\n");
    }

    // Map known filename patterns
    const resolved = resolveFilename(filename, providerName);
    if (resolved) {
      files.set(resolved, content.trim() + "\n");
    }
  }

  return files;
}

/**
 * Map a filename from Claude's output to the expected output path.
 */
function resolveFilename(
  filename: string,
  providerName: string,
): string | null {
  const f = filename.toLowerCase().trim();

  // Direct matches
  if (f.includes("auth-manager")) {
    return `core/util/${providerName}-auth-manager.tsx`;
  }
  if (f.includes("client")) {
    return `core/util/${providerName}-client.ts`;
  }
  if (f.includes("importer")) {
    return `${providerName}-importer.tsx`;
  }
  if (f.includes("auth")) {
    return `core/${providerName}-auth.tsx`;
  }

  // Fallback: keep as-is if it looks like a path
  if (f.endsWith(".ts") || f.endsWith(".tsx")) {
    return filename;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

main();
