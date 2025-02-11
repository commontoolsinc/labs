#!/usr/bin/env -S deno run --allow-net --allow-env

import { parseArgs } from "@std/cli/parse-args";
import { colors } from "@/routes/ai/llm/cli.ts";

const API_URL = Deno.env.get("API_URL") || "http://localhost:8000/api/ai/llm";
const TEST_SYSTEM_PROMPT = "Be creative.";
const TEST_PROMPT = "What's your favorite color?";

async function testLlm(modelName: string) {
  const payload = {
    model: modelName,
    system: TEST_SYSTEM_PROMPT,
    messages: [{ role: "user", content: TEST_PROMPT }],
    stream: false,
  };

  console.log(
    `\n  ${colors.blue}TEST REQUEST PAYLOAD for ${modelName}:${colors.reset}\n` +
      JSON.stringify(payload, null, 2) +
      "\n",
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
      `\n  ${colors.green}TEST RESPONSE for ${modelName}:${colors.reset}\n` +
        JSON.stringify(data, null, 2) +
        "\n",
    );
  } catch (error) {
    console.error(
      `${colors.red}ERROR for ${modelName}:${colors.reset} ${
        (error as Error).message
      }`,
    );
  }
}

function printUsage() {
  console.log(
    "Usage:\n" +
      "  deno run --allow-net --allow-env scripts/test-toolshed-llm.ts <modelName>\n" +
      "  deno run --allow-net --allow-env scripts/test-toolshed-llm.ts --variety [model1,model2,...]\n" +
      "If no models are provided with --variety, a default variety list is used.",
  );
}

async function main() {
  const args = parseArgs(Deno.args);

  let models: string[] = [];
  if (args.variety) {
    if (typeof args.variety === "string" && args.variety.trim() !== "") {
      models = args.variety.split(",").map((m: string) => m.trim());
    } else {
      models = [
        "gemini-2.0-flash",
        "gemini-2.0-flash-thinking",
        "gemini-2.0-pro",
        "o1-low",
        "o1-medium",
        "o1-high",
        "o3-mini-low",
        "o3-mini-medium",
        "o3-mini-high",
        "sonar-reasoning-pro",
        "sonar-pro",
        "sonar",
        "groq:llama-3.3-70b",
        "cerebras:llama-3.3-70b",
      ];
    }
  } else if (args._ && args._[0]) {
    models = [String(args._[0])];
  } else {
    printUsage();
    Deno.exit(1);
  }

  for (const model of models) {
    await testLlm(model);
  }
}

await main();
