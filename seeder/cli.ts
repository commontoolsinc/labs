import { parseArgs } from "@std/cli/parse-args";
import { setBlobbyServerUrl, storage } from "@commontools/runner";
import { setLLMUrl } from "@commontools/llm";
import { processScenario } from "./processor.ts";
import { type ExecutedScenario } from "./interfaces.ts";
import { scenarios } from "./scenarios.ts";
import { toolshedUrl } from "./env.ts";
import { ensureReportDir, generateReport } from "./report.ts";
import { browser, login } from "./jumble.ts";
import { createSession, Identity } from "@commontools/identity";
import { CharmManager } from "@commontools/charm";
const {
  name,
  tag,
  "no-cache": noCache,
  model = "anthropic:claude-3-7-sonnet-20250219",
} = parseArgs(
  Deno.args,
  {
    string: ["name", "tag", "model"],
    boolean: ["no-cache"],
  },
);

const cache = !noCache;

if (!name) {
  // FIXME(ja): if the name already exists, we should not use it!
  console.error("Error: Missing `--name`.");
  Deno.exit(1);
}

storage.setRemoteStorage(new URL(toolshedUrl));
setBlobbyServerUrl(toolshedUrl);
setLLMUrl(toolshedUrl);

// Track executed scenarios and steps
const executedScenarios: ExecutedScenario[] = [];

async function processScenarios({
  tag,
  name,
}: {
  tag: string | undefined;
  name: string;
}) {
  await ensureReportDir(name);
  const charmManager = new CharmManager(
    await createSession({
      identity: await Identity.fromPassphrase("common user"),
      name,
    }),
  );
  console.log(`Processing scenarios...`);

  for (const scenario of scenarios) {
    if (tag && (scenario.tags === undefined || !scenario.tags.includes(tag))) {
      continue;
    }
    const executedScenario = await processScenario({
      scenario,
      model,
      cache,
      name,
      charmManager,
    });
    executedScenarios.push(executedScenario);
  }
  console.log(`Processed ${executedScenarios.length} scenarios.`);
  return executedScenarios;
}

// FIXME(ja): if the tag doesn't exist, we should error out with warning, show the tags
try {
  await login(name!);
  await processScenarios({ tag, name });
  await ensureReportDir(name!);
  await generateReport(name!, executedScenarios, toolshedUrl, scenarios);
} finally {
  await new Promise((resolve) => setTimeout(resolve, 100));
  await browser.close();
  Deno.exit(0);
}
