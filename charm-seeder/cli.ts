import { parseArgs } from "@std/cli/parse-args";
import { ConsoleEvent, launch, Page } from "@astral/astral";
import { castNewRecipe, CharmManager } from "@commontools/charm";
import { getEntityId, setBobbyServerUrl, storage } from "@commontools/runner";
import { createSession, Identity } from "@commontools/identity";
import { client as llm } from "@commontools/llm";
import { charmSchema, processWorkflow } from "@commontools/charm";
import { NAME } from "@commontools/builder";
import { Cell } from "@commontools/runner";
import { scenarios, Step, Scenario } from "./scenarios.ts";
import { CommandType } from "./commands.ts";
import { generateObject } from "ai";
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
  args: ["--window-size=1280,1024"],
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

async function loginWithPage(targetPage: Page) {
  await targetPage.goto(new URL(`/${name}`, toolshedUrl).toString());
  await sleep(1000);
  const avatar = await targetPage.$("#user-avatar");
  if (avatar) {
    console.log("Already logged in");
    return;
  }

  // If not logged in, see if any credential data is
  // persisting. If so, destroy local data.
  await sleep(500);
  const clearCredsButton = await targetPage.$(
    "button[aria-label='clear-credentials']",
  );
  if (clearCredsButton) {
    await clearCredsButton.click();
  }

  // Try log in
  console.log("Logging in");

  // Click the first button, "register"
  await waitForSelectorClick(targetPage, "button[aria-label='register']");

  // Click the first button, "register with passphrase"
  await waitForSelectorClick(
    targetPage,
    "button[aria-label='register-with-passphrase']",
  );

  // Get the mnemonic from textarea.
  let input = await targetPage.waitForSelector("textarea[aria-label='mnemonic']");
  const mnemonic = await input!.evaluate((textarea: HTMLInputElement) =>
    textarea.value
  );

  // Click the SECOND button, "continue to login"
  await waitForSelectorClick(targetPage, "button[aria-label='continue-login']");

  // Paste the mnemonic in the input.
  input = await targetPage.waitForSelector("input[aria-label='enter-passphrase']");
  await input!.evaluate(
    (input: HTMLInputElement, mnemonic: string) => input.value = mnemonic,
    { args: [mnemonic] },
  );

  // Click the only button, "login"
  await waitForSelectorClick(targetPage, "button[aria-label='login']");

  await targetPage.waitForSelector("#user-avatar");
}

async function login() {
  await loginWithPage(page);
}

async function processPrompts() {
  let promptCount = 0;
  console.log(`Processing prompts...`);

  // Create a function that processes a single scenario
  async function processScenario(scenario: Scenario, index: number): Promise<void> {
    console.log(`[Scenario ${index}] Starting: ${scenario.name}`);
    
    // Create a new browser instance for each scenario
    const scenarioBrowser = await launch({
      args: ["--window-size=1280,1024"],
      headless: HEADLESS,
    });
    
    const scenarioPage = await scenarioBrowser.newPage();
    
    // Set up console logs capture
    const scenarioConsoleLogs: ConsoleEvent[] = [];
    scenarioPage.addEventListener("console", (e: ConsoleEvent) => {
      scenarioConsoleLogs.push(e);
      console.log(`[Scenario ${index}] ${e.detail?.type || 'log'}: ${e.detail?.text || ''}`);
    });
    
    try {
      // Login for this scenario's browser instance
      await loginWithPage(scenarioPage);
      
      await scenarioPage.goto(toolshedUrl);
      await sleep(1000);
      
      let lastCharmId: string | undefined = undefined;
      
      for (const step of scenario.steps) {
        promptCount++;
        const newCharmId = await processCommandWithPage(step, lastCharmId, scenarioPage, scenarioConsoleLogs);
        if (newCharmId) {
          lastCharmId = newCharmId;
        }
      }
      
      console.log(`[Scenario ${index}] Completed: ${scenario.name}`);
    } catch (error) {
      console.error(`[Scenario ${index}] Error in ${scenario.name}:`, error);
    } finally {
      await scenarioBrowser.close();
    }
  }
  
  // Process scenarios with concurrency limit
  const MAX_CONCURRENT = 3;
  
  for (let i = 0; i < scenarios.length; i += MAX_CONCURRENT) {
    const batch = scenarios.slice(i, i + MAX_CONCURRENT);
    const batchPromises = batch.map((scenario, batchIndex) => 
      processScenario(scenario, i + batchIndex)
    );
    
    // Wait for current batch to complete before starting next batch
    await Promise.all(batchPromises);
  }
  
  console.log(`Successfully processed ${promptCount} prompts.`);
}

function toCamelCase(input: string): string {
  // Handle empty string case
  if (!input) return "";

  // Split the input string by non-alphanumeric characters
  return input
    .split(/[^a-zA-Z0-9]/)
    .filter((word) => word.length > 0) // Remove empty strings
    .map((word, index) => {
      // First word should be all lowercase
      if (index === 0) {
        return word.toLowerCase();
      }
      // Other words should have their first letter capitalized and the rest lowercase
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join("");
}

export function getCharmNameAsCamelCase(
  cell: Cell<any>,
): string {
  return toCamelCase(cell.asSchema(charmSchema).key(NAME).get());
}

function processCommand(
  step: Step,
  lastCharmId: string | undefined,
): Promise<string | undefined> {
  consoleLogs.length = 0;
  return processCommandWithPage(step, lastCharmId, page, consoleLogs);
}

async function processCommandWithPage(
  step: Step,
  lastCharmId: string | undefined,
  targetPage: Page,
  targetConsoleLogs: ConsoleEvent[],
): Promise<string | undefined> {
  targetConsoleLogs.length = 0;
  const { type, prompt } = step;
  switch (type) {
    case CommandType.New: {
      console.log(`Adding: "${prompt}"`);
      const form = await processWorkflow(prompt, false, {
        charmManager,
        prefill: {
          classification: {
            workflowType: "imagine",
            confidence: 1.0,
            reasoning: "hard coded",
          },
        },
      });
      const charm = await castNewRecipe(charmManager, form);
      const id = getEntityId(charm);
      if (id) {
        console.log(`Charm added: ${id["/"]}`);
        await verifyCharmWithPage(id["/"], prompt, targetPage);
        return id["/"];
      }
      break;
    }
    case CommandType.Extend: {
      console.log(`Extending: "${prompt}"`);
      if (!lastCharmId) {
        throw new Error("Last charm ID is undefined.");
      }
      const charm = await charmManager.get(lastCharmId);
      const form = await processWorkflow(prompt, false, {
        charmManager,
        existingCharm: charm,
        prefill: {
          classification: {
            workflowType: "imagine",
            confidence: 1.0,
            reasoning: "hard coded",
          },
        },
      });

      await castNewRecipe(charmManager, form);
      const id = getEntityId(charm);
      if (id) {
        console.log(`Charm added: ${id["/"]}`);
        await verifyCharmWithPage(id["/"], prompt, targetPage);
        return id["/"];
      }
      break;
    }
    case CommandType.Other: {
      throw new Error("Unsupported command type.");
    }
  }
}

function addErrorListeners() {
  return addErrorListenersToPage(page);
}

function addErrorListenersToPage(targetPage: Page) {
  targetPage.evaluate(() => {
    // @ts-ignore: this code is stringified and sent to browser context
    globalThis.charmRuntimeErrors = [];
    globalThis.addEventListener("common-iframe-error", (e) => {
      // @ts-ignore: this code is stringified and sent to browser context
      globalThis.charmRuntimeErrors.push(e.detail.description);
    });
  });
}

function checkForErrors() {
  return checkForErrorsInPage(page);
}

async function checkForErrorsInPage(targetPage: Page) {
  return await targetPage.evaluate(() => {
    // @ts-ignore: this code is stringified and sent to browser context
    return globalThis.charmRuntimeErrors;
  });
}

function screenshot(id: string) {
  return screenshotWithPage(id, page);
}

async function screenshotWithPage(id: string, targetPage: Page) {
  const screenshot = await targetPage.screenshot();
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

// Helper function to group results by scenario
function groupResultsByScenario(
  results: CharmResult[],
): Map<number, { name: string; results: CharmResult[] }> {
  const groups = new Map<number, { name: string; results: CharmResult[] }>();
  let currentScenario = 0;

  // Initialize the first scenario group
  groups.set(currentScenario, {
    name: scenarios[currentScenario]?.name || `Scenario ${currentScenario + 1}`,
    results: [],
  });

  // Process each result
  for (let i = 0; i < results.length; i++) {
    const result = results[i];

    // Check if we need to move to the next scenario
    // We do this by checking if we've processed all steps in the current scenario
    let stepsInCurrentScenario = 0;
    for (let j = 0; j <= currentScenario; j++) {
      if (j < scenarios.length) {
        stepsInCurrentScenario += scenarios[j].steps.length;
      }
    }

    // If we've processed all steps in the current scenario, move to the next one
    if (i >= stepsInCurrentScenario && currentScenario < scenarios.length - 1) {
      currentScenario++;
      groups.set(currentScenario, {
        name: scenarios[currentScenario]?.name ||
          `Scenario ${currentScenario + 1}`,
        results: [],
      });
    }

    // Add the result to the current scenario group
    groups.get(currentScenario)!.results.push(result);
  }

  return groups;
}

async function generateReport() {
  // Calculate overall statistics
  const totalScenarios = scenarios.length;
  const totalSteps = charmResults.length;
  const totalPassed = charmResults.filter((r) => r.status === "PASS").length;
  const totalFailed = totalSteps - totalPassed;
  const passRate = totalSteps > 0
    ? Math.round((totalPassed / totalSteps) * 100)
    : 0;

  // Calculate statistics per scenario
  const scenarioGroups = groupResultsByScenario(charmResults);

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
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    .fade-in {
      animation: fadeIn 0.5s ease-in-out;
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .hover-scale {
      transition: transform 0.3s ease;
    }
    .hover-scale:hover {
      transform: scale(1.03);
    }
  </style>
</head>
<body class="bg-gray-50 min-h-screen">
  <div class="container mx-auto px-4 py-8">
    <h1 class="text-3xl font-bold text-center text-gray-800 mb-4">${name}</h1>

    <!-- Summary Section -->
    <div class="mb-8 fade-in bg-white p-5 rounded-lg shadow-md">
      <h2 class="text-xl font-semibold mb-3 border-b pb-2">Summary</h2>
      <div class="grid grid-cols-1 md:grid-cols-4 gap-4 text-center">
        <div class="bg-blue-50 p-3 rounded-lg">
          <p class="text-blue-800 font-bold text-2xl">${totalScenarios}</p>
          <p class="text-blue-600">Scenarios</p>
        </div>
        <div class="bg-gray-50 p-3 rounded-lg">
          <p class="text-gray-800 font-bold text-2xl">${totalSteps}</p>
          <p class="text-gray-600">Total Steps</p>
        </div>
        <div class="bg-green-50 p-3 rounded-lg">
          <p class="text-green-800 font-bold text-2xl">${totalPassed}</p>
          <p class="text-green-600">Passed</p>
        </div>
        <div class="bg-red-50 p-3 rounded-lg">
          <p class="text-red-800 font-bold text-2xl">${totalFailed}</p>
          <p class="text-red-600">Failed</p>
        </div>
      </div>
      <div class="mt-4 w-full bg-gray-200 rounded-full h-4">
        <div class="bg-green-500 h-4 rounded-full" style="width: ${passRate}%"></div>
      </div>
      <p class="text-center mt-1 text-gray-600">${passRate}% Success Rate</p>
    </div>

    ${
    Array.from(scenarioGroups).map(
      ([scenarioIndex, scenarioData], groupIndex) => {
        const scenarioPassed =
          scenarioData.results.filter((r) => r.status === "PASS").length;
        const scenarioFailed = scenarioData.results.length - scenarioPassed;
        const scenarioPassRate = scenarioData.results.length > 0
          ? Math.round((scenarioPassed / scenarioData.results.length) * 100)
          : 0;
        const headerBgColor = scenarioPassRate >= 80
          ? "bg-blue-600"
          : scenarioPassRate >= 50
          ? "bg-yellow-500"
          : "bg-red-600";

        return `
        <div class="mb-10 fade-in" style="animation-delay: ${
          groupIndex * 0.1
        }s">
          <div class="${headerBgColor} text-white py-3 px-5 rounded-t-lg shadow-md flex justify-between items-center">
            <h2 class="text-xl font-semibold">${scenarioData.name}</h2>
            <div class="flex items-center space-x-2">
              <span class="bg-white text-green-700 px-2 py-1 rounded-md text-sm">${scenarioPassed} ✓</span>
              <span class="bg-white text-red-700 px-2 py-1 rounded-md text-sm">${scenarioFailed} ✗</span>
              <span class="bg-white text-gray-700 px-2 py-1 rounded-md text-sm">${scenarioPassRate}%</span>
            </div>
          </div>
          <div class="bg-white p-5 rounded-b-lg shadow-md">
            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              ${
          scenarioData.results.map((result, index) => {
            const relativePath = result.screenshotPath.replace(
              `results/`,
              "./",
            );
            const statusColor = result.status === "PASS"
              ? "bg-green-100 text-green-800"
              : "bg-red-100 text-red-800";

            return `
                    <div class="bg-white rounded-lg overflow-hidden shadow-md hover-scale fade-in" style="animation-delay: ${
              (groupIndex * 0.1) + (index * 0.05)
            }s">
                      <div class="relative">
                        <a href="${relativePath}" target="_blank">
                          <img src="${relativePath}" alt="Screenshot" class="w-full h-48 object-cover">
                        </a>
                        <div class="absolute top-0 right-0 m-2">
                          <span class="px-3 py-1 rounded-full text-sm font-medium ${statusColor}">
                            ${result.status}
                          </span>
                        </div>
                      </div>
                      <div class="p-4">
                        <a href="${toolshedUrl}/${name}/${result.id}" class="text-blue-600 hover:text-blue-800 font-medium" target="_blank">
                          Charm ID: ${result.id.slice(-6)}
                        </a>
                        <p class="mt-2 text-gray-700 font-medium">Prompt:</p>
                        <p class="text-gray-600 mb-3">${result.prompt}</p>
                        <p class="text-gray-700 font-medium">Verdict:</p>
                        <p class="text-gray-600">${result.summary}</p>
                      </div>
                    </div>
                  `;
          }).join("")
        }
            </div>
          </div>
        </div>
      `;
      },
    ).join("")
  }
  </div>
</body>
</html>
  `;

  const reportPath = `results/${name}.html`;
  await Deno.writeTextFile(reportPath, html);
  console.log(`Report generated: ${reportPath}`);
}

function verifyCharm(id: string, prompt: string): Promise<string> {
  return verifyCharmWithPage(id, prompt, page);
}

async function verifyCharmWithPage(id: string, prompt: string, targetPage: Page): Promise<string> {
  // FIXME(ja): can we navigate without causing a page reload?
  await targetPage.goto(new URL(`/${name}/${id}`, toolshedUrl).toString());
  addErrorListenersToPage(targetPage);
  await sleep(5000);
  const filename = await screenshotWithPage(id, targetPage);
  const errors = await checkForErrorsInPage(targetPage);
  if (errors.length > 0) {
    charmResults.push({
      id,
      prompt,
      screenshotPath: filename,
      status: "FAIL",
      summary: `Errors: ${errors.join("\n")}`,
    });
    return `Error: ${errors.join("\n")}`;
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
  await login();
  await processPrompts();
  await generateReport();
} catch (e) {
  console.error(e);
} finally {
  await sleep(500);
  await browser.close();
  Deno.exit(0);
}
