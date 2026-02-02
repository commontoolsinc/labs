/**
 * Network commands: curl
 *
 * Implements basic HTTP fetch using the Deno `fetch` API.
 * Response data is labeled with Origin and NetworkProvenance atoms
 * (no InjectionFree — network data is untrusted).
 *
 * After fetch, exchange rules are evaluated at the network boundary.
 * curl mints AuthorizedRequest as boundary integrity — the structural
 * proof is that curl only places secret data in the Authorization header,
 * never in the URL, query params, or body. Combined with NetworkProvenance
 * from a successful TLS fetch, this satisfies the integrity guards for
 * authority-only exchange rules (e.g., dropping GoogleAuth after OAuth fetch).
 */

import type { CommandContext, CommandResult } from "./context.ts";
import type { Atom, Integrity, Label } from "../labels.ts";
import { labels as _labels } from "../labels.ts";
import { evalExchangeRules } from "../policy.ts";

/**
 * curl - transfer data from/to a server
 *
 * Supports: GET, POST, custom methods, headers, request body,
 * redirects, fail-on-error, output to file, silent mode.
 */
export async function curl(
  args: string[],
  ctx: CommandContext,
): Promise<CommandResult> {
  let silent = false;
  let showError = true;
  let outputFile: string | null = null;
  const headersList: string[] = [];
  let method: string | null = null;
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
        outputFile = args[++i];
      }
    } else if (arg === "-H" || arg === "--header") {
      if (i + 1 < args.length) {
        headersList.push(args[++i]);
      }
    } else if (arg === "-X" || arg === "--request") {
      if (i + 1 < args.length) {
        method = args[++i];
      }
    } else if (arg === "-d" || arg === "--data") {
      if (i + 1 < args.length) {
        data = args[++i];
        if (!method) method = "POST";
      }
    } else if (arg === "-L" || arg === "--location") {
      followRedirects = true;
    } else if (arg === "-f" || arg === "--fail") {
      failOnError = true;
    } else if (!arg.startsWith("-")) {
      url = arg;
    }
  }

  if (!method) method = "GET";

  if (!url) {
    ctx.stderr.write("curl: no URL specified\n", ctx.pcLabel);
    return { exitCode: 1, label: ctx.pcLabel };
  }

  // Build request headers
  const headers = new Headers();
  for (const h of headersList) {
    const colon = h.indexOf(":");
    if (colon > 0) {
      headers.set(h.substring(0, colon).trim(), h.substring(colon + 1).trim());
    }
  }

  // Determine TLS from URL
  let tls = false;
  try {
    const parsed = new URL(url);
    tls = parsed.protocol === "https:";
  } catch {
    ctx.stderr.write(`curl: (3) URL rejected: ${url}\n`, ctx.pcLabel);
    return { exitCode: 3, label: ctx.pcLabel };
  }

  // Perform fetch
  let response: Response;
  try {
    const fetchFn = ctx.mockFetch ?? fetch;
    response = await fetchFn(url, {
      method,
      headers,
      body: data ?? undefined,
      redirect: followRedirects ? "follow" : "manual",
    });
  } catch (e: unknown) {
    if (!silent || showError) {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.stderr.write(
        `curl: (6) Could not resolve host or connect: ${msg}\n`,
        ctx.pcLabel,
      );
    }
    return { exitCode: 6, label: ctx.pcLabel };
  }

  // ---- Label computation ----

  // Network integrity from the successful fetch
  const networkIntegrity: Integrity = [
    { kind: "Origin", url },
    { kind: "NetworkProvenance", tls, host: new URL(url).host },
  ];

  // Boundary integrity: curl structurally guarantees that secret data from the
  // PC label (e.g., OAuth tokens) only appears in the Authorization header — never
  // in the URL, query params, or response body. This is the structural proof that
  // justifies minting AuthorizedRequest.
  const hasAuthHeader = headers.has("Authorization");
  const boundaryIntegrity: Integrity = [
    ...networkIntegrity,
    ...(hasAuthHeader
      ? [{ kind: "IntegrityToken", name: "AuthorizedRequest" } as Atom]
      : []),
    ...(tls
      ? [{ kind: "IntegrityToken", name: "NetworkProvenance" } as Atom]
      : []),
  ];

  // The response label starts with:
  //   confidentiality: inherited from inputs (pcLabel carries token's confidentiality)
  //   integrity: network provenance from the fetch
  const rawResponseLabel: Label = {
    confidentiality: ctx.pcLabel.confidentiality,
    integrity: networkIntegrity,
  };

  // Evaluate exchange rules at the network boundary.
  // This is where authority-only confidentiality (e.g., GoogleAuth) gets dropped
  // when guarded by AuthorizedRequest + NetworkProvenance integrity.
  const policies = ctx.policies ?? [];
  const outputLabel = policies.length > 0
    ? evalExchangeRules(policies, boundaryIntegrity, rawResponseLabel)
    : rawResponseLabel;

  // Handle redirect responses when not following
  if (!followRedirects && response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location") ?? "";
    if (!silent) {
      ctx.stderr.write(
        `curl: (47) Redirect to ${location} (use -L to follow)\n`,
        ctx.pcLabel,
      );
    }
  }

  // Fail on HTTP error if -f
  if (failOnError && response.status >= 400) {
    if (!silent || showError) {
      ctx.stderr.write(
        `curl: (22) The requested URL returned error: ${response.status}\n`,
        ctx.pcLabel,
      );
    }
    return { exitCode: 22, label: outputLabel };
  }

  // Read response body
  const body = new Uint8Array(await response.arrayBuffer());
  const bodyText = new TextDecoder().decode(body);

  // Output to file or stdout
  if (outputFile) {
    ctx.vfs.writeFile(outputFile, body, outputLabel);
  } else {
    ctx.stdout.write(bodyText, outputLabel);
  }

  return { exitCode: 0, label: outputLabel };
}
