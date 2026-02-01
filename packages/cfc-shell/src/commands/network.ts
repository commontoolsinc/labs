/**
 * Network commands: curl
 *
 * This is a STUB for Phase 4. Actual network calls happen in Phase 7 (sandboxed exec).
 * The key implementation here is the LABEL LOGIC: request body checking and response labeling.
 */

import type { CommandContext, CommandResult } from "./context.ts";
import { labels } from "../labels.ts";

/**
 * curl - transfer data from/to a server (STUB)
 */
export async function curl(args: string[], ctx: CommandContext): Promise<CommandResult> {
  let silent = false;
  let showError = true;
  let outputFile: string | null = null;
  let headers: string[] = [];
  let method = "GET";
  let data: string | null = null;
  let followRedirects = false;
  let failOnError = false;
  let url: string | null = null;

  // Parse args
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "-s" || arg === "--silent") {
      silent = true;
      showError = false;
    } else if (arg === "-S" || arg === "--show-error") {
      showError = true;
    } else if (arg === "-o" || arg === "--output") {
      if (i + 1 < args.length) {
        outputFile = args[i + 1];
        i++;
      }
    } else if (arg === "-H" || arg === "--header") {
      if (i + 1 < args.length) {
        headers.push(args[i + 1]);
        i++;
      }
    } else if (arg === "-X" || arg === "--request") {
      if (i + 1 < args.length) {
        method = args[i + 1];
        i++;
      }
    } else if (arg === "-d" || arg === "--data") {
      if (i + 1 < args.length) {
        data = args[i + 1];
        method = "POST";
        i++;
      }
    } else if (arg === "-L" || arg === "--location") {
      followRedirects = true;
    } else if (arg === "-f" || arg === "--fail") {
      failOnError = true;
    } else if (!arg.startsWith("-")) {
      url = arg;
    }
  }

  if (!url) {
    ctx.stderr.write("curl: no URL specified\n", ctx.pcLabel);
    return { exitCode: 1, label: ctx.pcLabel };
  }

  // LABEL CHECKING: Check if data being sent has appropriate confidentiality for target
  if (data) {
    // In a real implementation, we'd check exchange rules here
    // For now, we'll just track the label
    const dataLabel = ctx.pcLabel; // Data comes from command, inherits PC label

    // Check: is this data allowed to flow to this URL?
    // This is where we'd call the exchange rule evaluator
    // For now, we'll just note it in the output

    if (showError) {
      ctx.stderr.write(
        `[CFC-SHELL] Network access requires sandboxed execution. Use: !real curl ...\n`,
        ctx.pcLabel
      );
    }

    return { exitCode: 1, label: ctx.pcLabel };
  }

  // For GET requests, also block but show the stub message
  if (showError) {
    ctx.stderr.write(
      `[CFC-SHELL] Network access requires sandboxed execution. Use: !real curl ...\n`,
      ctx.pcLabel
    );
  }

  // RESPONSE LABELING: If we were to fetch, the response would be labeled with:
  // - Origin(url)
  // - NetworkProvenance(tls, host)
  //
  // This is implemented in Phase 7 when we actually perform the fetch.

  return { exitCode: 1, label: ctx.pcLabel };
}
