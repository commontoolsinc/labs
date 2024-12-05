import { config } from "https://deno.land/x/dotenv/mod.ts";
import { ALIAS_NAMES, findModel, MODELS, PROVIDER_NAMES } from "./models.ts";
import { colors } from "./cli.ts";

await config({ export: true });

// Including timestamp as cache break
const NOW = new Date().toISOString();
const TEST_SYSTEM_PROMPT = "Think deeply, be creative.";
const TEST_PROMPT = `${NOW}: Favorite color? One word.`;

const API_URL = Deno.env.get("PLANNING_API_URL") || "http://localhost:8000";

console.log(`Using ${colors.blue}${API_URL}${colors.reset} as planning server`);

const varietyModels = [
  "anthropic:claude-3-5-haiku-20241022",
  // "anthropic:claude-3-5-sonnet-20241022",
  // "anthropic:claude-3-opus-20240229",
  // "groq:llama-3.1-70b-versatile",
  "groq:llama-3.1-8b-instant",
  // "groq:llama-3.2-11b-vision-preview",
  // "groq:llama-3.2-90b-vision-preview",
  // "groq:llama-3.2-3b-preview",
  "openai:gpt-4o-2024-08-06",
  // "openai:gpt-4o-mini-2024-07-18",
  // "openai:o1-preview-2024-09-12",
  // "openai:o1-mini-2024-09-12",
  "google:gemini-1.5-flash-002",
  // "google:gemini-1.5-pro-002",
  "amazon:nova-micro",
  // "amazon:nova-lite",
  // "amazon:nova-pro",
];

async function testModel(modelName: string) {
  console.log(
    `\n${colors.bright}Testing ${colors.blue}${modelName}${colors.reset}`,
  );

  const modelConfig = findModel(modelName);
  if (!modelConfig) {
    console.log(`${colors.red}Model not found: ${modelName}${colors.reset}`);
    return;
  }

  const payload = {
    model: modelName,
    system: TEST_SYSTEM_PROMPT,
    messages: [{ role: "user", content: TEST_PROMPT }],
    stream: false,
  };

  console.log(
    `\n    ${colors.blue}PAYLOAD:${colors.reset} ${JSON.stringify(
      payload,
      null,
      2,
    )
      .split("\n")
      .join("\n    ")}\n`,
  );
  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    console.log(
      `    ${colors.green}RESPONSE:${colors.reset} ${data.content}\n`,
    );
  } catch (error) {
    console.error(`${colors.red}ERROR:${colors.reset} ${error.message}\n`);
  }
}

async function main() {
  const arg = Deno.args[0]?.toLowerCase();

  if (!arg) {
    console.log(
      "Usage: deno run livetest.ts <modelName|all|variety|google|openai|anthropic|groq|provider_name>",
    );
    console.log(`Available models: ${Object.keys(MODELS).join(", ")}`);
    console.log(`Available providers: ${Array.from(PROVIDER_NAMES)}`);
    Deno.exit(1);
  }

  if (arg === "all") {
    for (const modelName of Object.keys(MODELS)) {
      if (ALIAS_NAMES.includes(modelName)) continue;
      await testModel(modelName);
    }
  } else if (arg === "variety") {
    for (const modelName of varietyModels) {
      await testModel(modelName);
    }
  } else if (PROVIDER_NAMES.has(arg)) {
    const providerModels = Object.keys(MODELS).filter(model => {
      return (
        model.toLowerCase().startsWith(arg) && !ALIAS_NAMES.includes(model)
      );
    });
    for (const modelName of providerModels) {
      await testModel(modelName);
    }
  } else {
    await testModel(arg);
  }
}

await main();
