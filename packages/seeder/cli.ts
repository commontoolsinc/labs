import { parseArgs } from "@std/cli/parse-args";
import { Runtime } from "@commontools/runner";
import { StorageManager } from "@commontools/runner/storage/cache";
import { setLLMUrl } from "@commontools/llm";
import { createSession, Identity } from "@commontools/identity";
import { CharmManager } from "@commontools/charm";
import { sleep } from "@commontools/utils/sleep";
import { Processor } from "./processor.ts";
import { scenarios } from "./scenarios.ts";
import { ExecutedScenario } from "./interfaces.ts";
import { ensureReportDir, generateReport } from "./report.ts";
import { Verifier } from "./verifier.ts";

const {
  name,
  tag,
  "no-cache": noCache,
  "no-verify": noVerify,
  "no-report": noReport,
  model = "anthropic:claude-3-7-sonnet-20250219",
} = parseArgs(
  Deno.args,
  {
    string: ["name", "tag", "model"],
    boolean: ["no-cache", "no-verify", "no-report"],
  },
);

if (!noVerify && !Deno.env.get("OPENAI_API_KEY")) {
  throw new Error("OPENAI_API_KEY is not set");
}
const headless = !(Deno.env.get("HEADLESS") === "false");
const cache = !noCache;
const apiUrl = Deno.env.get("TOOLSHED_API_URL") ??
  "https://toolshed.saga-castor.ts.net/";

if (!name) {
  // FIXME(ja): if the name already exists, we should not use it!
  console.error("Error: Missing `--name`.");
  Deno.exit(1);
}

// Storage and blobby server URL are now configured in Runtime constructor
setLLMUrl(apiUrl);

const identity = await Identity.fromPassphrase("common user");
const session = await createSession({
  identity,
  name,
});

const runtime = new Runtime({
  storageManager: StorageManager.open({
    address: new URL("/api/storage/memory", apiUrl),
    as: session.as,
  }),
  blobbyServerUrl: apiUrl,
});

const charmManager = new CharmManager(session, runtime);

const verifier =
  await (noVerify ? undefined : Verifier.initialize({ apiUrl, headless, identity }));
const processor = new Processor({ name, model, cache, charmManager, verifier });

let processed: ExecutedScenario[] | undefined;
try {
  if (!noReport) await ensureReportDir(name);
  // FIXME(ja): if the tag doesn't exist, we should error out with warning, show the tags
  processed = await processor.process(scenarios, tag);
  if (!noReport) await generateReport(name!, processed, apiUrl);
} finally {
  await sleep(100);
  if (verifier) await verifier.close();
  if (!processed) {
    Deno.exit(1);
  }

  const success = processed.every(({ results }) =>
    results.every(({ status }) => status === "PASS" || status === "NOTVERIFIED")
  );
  if (success) {
    Deno.exit(0);
  }
  Deno.exit(1);
}
