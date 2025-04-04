import { parseArgs } from "@std/cli/parse-args";
import { ConsoleEvent, launch, Page } from "@astral/astral";
import { castNewRecipe, CharmManager } from "@commontools/charm";
import { getEntityId, setBobbyServerUrl, storage } from "@commontools/runner";
import { createSession, Identity } from "@commontools/identity";
import { client as llm } from "@commontools/llm";
import { scenarios, Step } from "./scenarios.ts";
import { CommandType } from "./commands.ts";
import { generateObject, generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";

const toolshedUrl = Deno.env.get("TOOLSHED_API_URL") ??
  "https://toolshed.saga-castor.ts.net/";

const { name } = parseArgs(Deno.args, {
  string: ["name"],
});

if (!name) {
  console.error("Error: Missing `--name`.");
  Deno.exit(1);
}

const HEADLESS = false;
const browser = await launch({
  args: ["--window-size=1200,800"],
  headless: HEADLESS,
});
const page = await browser.newPage();

const consoleLogs: ConsoleEvent[] = [];

page.addEventListener("console", (e: ConsoleEvent) => {
  consoleLogs.push(e);
});

storage.setRemoteStorage(new URL(toolshedUrl));
setBobbyServerUrl(toolshedUrl);
llm.setServerUrl(toolshedUrl);

const charmManager = new CharmManager(
  await createSession({
    identity: await Identity.fromPassphrase("common user"),
    name,
  }),
);

export async function waitForSelectorClick(
  page: Page,
  selector: string,
): Promise<void> {
  console.log(`Waiting for "${selector}"...`);
  const el = await page.waitForSelector(selector);
  console.log(`Found "${selector}"! Clicking...`);
  await el.click();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function login() {
  await page.goto(`http://localhost:5173/${name}`);
  await sleep(1000);
  const avatar = await page.$("#user-avatar");
  if (avatar) {
    console.log("Already logged in");
    return;
  }

  // If not logged in, see if any credential data is
  // persisting. If so, destroy local data.
  await sleep(500);
  const clearCredsButton = await page.$(
    "button[aria-label='clear-credentials']",
  );
  if (clearCredsButton) {
    await clearCredsButton.click();
  }

  // Try log in
  console.log("Logging in");

  // Click the first button, "register"
  await waitForSelectorClick(page, "button[aria-label='register']");

  // Click the first button, "register with passphrase"
  await waitForSelectorClick(
    page,
    "button[aria-label='register-with-passphrase']",
  );

  // Get the mnemonic from textarea.
  let input = await page.waitForSelector("textarea[aria-label='mnemonic']");
  const mnemonic = await input!.evaluate((textarea: HTMLInputElement) =>
    textarea.value
  );

  // Click the SECOND button, "continue to login"
  await waitForSelectorClick(page, "button[aria-label='continue-login']");

  // Paste the mnemonic in the input.
  input = await page.waitForSelector("input[aria-label='enter-passphrase']");
  await input!.evaluate(
    (input: HTMLInputElement, mnemonic: string) => input.value = mnemonic,
    { args: [mnemonic] },
  );

  // Click the only button, "login"
  await waitForSelectorClick(page, "button[aria-label='login']");

  await page.waitForSelector("#user-avatar");
}

async function processPrompts() {
  let promptCount = 0;
  console.log(`Processing prompts...`);

  for (const scenario of scenarios) {
    for (const step of scenario.steps) {
      promptCount++;
      await processCommand(step);
    }
  }
  console.log(`Successfully processed ${promptCount} prompts.`);
}

async function processCommand(step: Step) {
  await page.goto(`http://localhost:5173/`);
  await sleep(1000);
  consoleLogs.length = 0;
  const { type, prompt } = step;
  switch (type) {
    case CommandType.New: {
      console.log(`Adding: "${prompt}"`);
      const charm = await castNewRecipe(charmManager, prompt);
      const id = getEntityId(charm);
      if (id) {
        console.log(`Charm added: ${id["/"]}`);
        await verifyCharm(id["/"], prompt);
      }
      break;
    }
    case CommandType.Other: {
      throw new Error("Unsupported command type.");
    }
  }
}

function checkForErrors() {
  const errorLogs = consoleLogs.filter((log) =>
    log.detail.type === "error" &&
    log.detail.text.startsWith("charm-runtime-error")
  );
  consoleLogs.length = 0;
  if (errorLogs.length > 0) {
    const errorText = errorLogs[0].detail.text;
    // Remove the "charm-runtime-error" prefix
    const jsonText = errorText.replace("charm-runtime-error", "").trim();
    try {
      return JSON.parse(jsonText);
    } catch (e) {
      return errorText;
    }
  }
}

async function screenshot(id: string) {
  const screenshot = await page.screenshot();
  // Create directory if it doesn't exist
  const dirPath = `results/${name}`;
  try {
    await Deno.mkdir(dirPath, { recursive: true });
  } catch (e) {
    // Directory might already exist, which is fine
  }

  // Use just the charm name as the filename
  const filename = `${dirPath}/${id}.png`;
  await Deno.writeFile(filename, screenshot);
  return filename;
}

async function llmVerifyCharm(
  prompt: string,
  filename: string,
): Promise<string> {
  const system = `You are a helpful assistant that verifies charm screenshots.

Your task is to evaluate how well the screenshot represents what the user asked for in the prompt.
    
If the screenshot accurately represents the prompt, return a PASS result with a brief explanation.
If the screenshot does not match the prompt, return a FAIL result with a brief explanation of what's missing or incorrect.`;

  const schema = z.object({
    result: z.enum(["PASS", "FAIL"]),
    summary: z.string().describe("A 1-sentence summary of your evaluation"),
  });

  const { object } = await generateObject({
    system: system,
    model: openai("gpt-4o-mini"),
    schema,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: prompt,
          },
          { type: "image", image: Deno.readFileSync(filename) },
        ],
      },
    ],
  });

  const result = schema.parse(object);
  console.log({ result });
  return JSON.stringify(result);
}

// Store results for the report
interface CharmResult {
  id: string;
  prompt: string;
  screenshotPath: string;
  status: string;
  summary: string;
}

const charmResults: CharmResult[] = [];

async function generateReport() {
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${name} - ${
    new Date().toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    })
  }</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
      max-width: 1200px;
      margin: 0 auto;
      padding: 20px;
      background-color: #f5f5f5;
    }
    h1 {
      color: #333;
      text-align: center;
      margin-bottom: 30px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      background-color: white;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
      border-radius: 8px;
      overflow: hidden;
    }
    th, td {
      padding: 12px 15px;
      text-align: left;
      border-bottom: 1px solid #eee;
    }
    th {
      background-color: #f8f9fa;
      font-weight: 600;
    }
    tr:last-child td {
      border-bottom: none;
    }
    .thumbnail {
      width: 150px;
      height: 100px;
      object-fit: cover;
      border-radius: 4px;
    }
    .status {
      display: inline-block;
      padding: 4px 8px;
      border-radius: 4px;
      font-weight: 500;
      font-size: 14px;
    }
    .status-pass {
      background-color: #d4edda;
      color: #155724;
    }
    .status-fail {
      background-color: #f8d7da;
      color: #721c24;
    }
    .link {
      color: #007bff;
      text-decoration: none;
    }
    .link:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <h1>Charm Seeder Results - ${name}</h1>
  <table>
    <thead>
      <tr>
        <th>Thumbnail</th>
        <th>ID</th>
        <th>Prompt</th>
        <th>Status</th>
        <th>Summary</th>
      </tr>
    </thead>
    <tbody>
      ${
    charmResults.map((result) => {
      // Convert the full path to a relative path for the HTML
      const relativePath = result.screenshotPath.replace(
        `results/`,
        "./",
      );
      return `
        <tr>
          <td><img src="${relativePath}" alt="Screenshot" class="thumbnail"></td>
          <td><a href="http://localhost:5173/${name}/${result.id}" class="link" target="_blank">${result.id}</a></td>
          <td>${result.prompt}</td>
          <td><span class="status status-${result.status.toLowerCase()}">${result.status}</span></td>
          <td>${result.summary}</td>
        </tr>
      `;
    }).join("")
  }
    </tbody>
  </table>
</body>
</html>
  `;

  const reportPath = `results/${name}.html`;
  await Deno.writeTextFile(reportPath, html);
  console.log(`Report generated: ${reportPath}`);
}

async function verifyCharm(id: string, prompt: string): Promise<string> {
  // FIXME(ja): can we navigate without causing a page reload?
  await page.goto(`http://localhost:5173/${name}/${id}`);
  await sleep(5000);
  const filename = await screenshot(id);
  const error = checkForErrors();
  if (error) {
    console.error("Error:", error);
    // Add failed result to charmResults
    charmResults.push({
      id,
      prompt,
      screenshotPath: filename,
      status: "FAIL",
      summary: `Error: ${
        typeof error === "string" ? error : JSON.stringify(error)
      }`,
    });
    return `Error: ${error}`;
  }

  const verdict = await llmVerifyCharm(prompt, filename);
  console.log(`Charm verified: ${id} - ${verdict}`);

  // Parse the verdict and add to results
  const parsedVerdict = JSON.parse(verdict);
  charmResults.push({
    id,
    prompt,
    screenshotPath: filename,
    status: parsedVerdict.result,
    summary: parsedVerdict.summary,
  });

  return verdict;
}

try {
  // await llmVerifyCharm(
  //   "2048 game",
  //   "results/a-baedreiew75mhu47xkvza2cyf3xja7dvin5cgvbp2p5jyiaf3utpqnqn574.png",
  // );
  // Deno.exit(0);

  await login();
  await processPrompts();
  await generateReport();
} finally {
  await sleep(500);
  await browser.close();
  Deno.exit(0);
}
