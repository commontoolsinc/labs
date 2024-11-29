import { join } from "@std/path";
import { exists } from "@std/fs";
import { iterate } from "./prompts.ts";
import { chromium, Page } from "playwright";
import { Action, ActionResult } from "./recipes/actions.ts";
import { ensureDir } from "@std/fs";

const recipeDir = join(Deno.cwd(), "recipes");
async function runRecipeActions(page: Page, actions: Action[]) {
  const rv = [] as ActionResult[];
  let action;
  for (action of actions) {
    if (action.type === "click") {
      try {
        await page.getByRole(...action.args).click({ timeout: 250 });
        rv.push({ success: true, action });
      } catch (e) {
        rv.push({
          error: e instanceof Error ? e.message : JSON.stringify(e),
          success: false,
          action,
        });
      }
    }
  }
  return rv;
}

async function testOneRecipe(recipe: string, actions: Action[]): Promise {
  let info = {} as any;

  // TODO: remove any old generated source

  info["originalSrc"] = await Deno.readTextFile(
    join(recipeDir, `${recipe}.tsx`),
  );
  info["originalSpec"] = await Deno.readTextFile(
    join(recipeDir, `${recipe}.ogspec.md`),
  );
  info["workingSpec"] = await Deno.readTextFile(
    join(recipeDir, `${recipe}.newspec.md`),
  );
  info["actions"] = actions;

  // exit if these inputs arent set
  const payload = await iterate({
    originalSrc: info["originalSrc"],
    originalSpec: info["originalSpec"],
    workingSpec: info["workingSpec"],
  });

  info = { ...payload, ...info };

  if (info["generatedSrc"] === undefined) {
    return info;
  }

  const newSrcPath = join(recipeDir, `new-${recipe}.tsx`);
  await Deno.writeTextFile(newSrcPath, info["generatedSrc"]);
  const srcUrl = `http://localhost:8000/recipes/new-${recipe}.tsx`;
  const loadUrl = `http://localhost:5173/newRecipe?src=${encodeURIComponent(
    srcUrl,
  )}`;

  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  const loaded = new Promise<string | true>(resolve => {
    page.on("console", msg => {
      if (msg.type() == "eror") {
        if (msg.text().includes("Errors in recipe:")) {
          // TODO(jake): make this expose the full error/stack trace??
          const error = msg.text().split("Errors in recipe: ")[1];
          resolve(error);
        }
      }

      if (msg.text().includes("Recipe successfully loaded")) {
        console.log(`Recipe successfully loaded: "${msg.text()}"`);
        resolve(true);
      }
    });
  });

  await page.goto(loadUrl);

  const status = await loaded;
  if (typeof status === "string") {
    info["compileError"] = status;
    // browser.close();
    return info;
  }

  // this should have details for all the tests ... perhaps including screenshots, any error logs, ...
  info["tests"] = await runRecipeActions(page, info["actions"]);

  // note(ja): this is silly, but until info['tests'] does the right thing, it is the best we can do
  if (info["tests"] === true) {
    info["success"] = new Date();
  }

  await browser.close();

  return info;
}

function generateReportHtml(info: any): string {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Test Report for ${info.testName || "Unknown Test"}</title>
      <style>
        /* Add your styles here */
        body { font-family: sans-serif; padding: 20px; }
        h1, h2 { color: #333; }
        .success { color: green; }
        .failure { color: red; }
        pre { background-color: #f0f0f0; padding: 10px; }
      </style>
    </head>
    <body>
      <h1>Test Report for ${info.testName || "Unknown Test"}</h1>
      <p>Generated at: ${new Date().toLocaleString()}</p>
      
      ${
        info.compileError
          ? `
        <h2>Compile Error</h2>
        <pre>${info.compileError}</pre>
      `
          : ""
      }

      <h2>Actions</h2>
      <ul>
        ${info.tests
          .map(
            (test: any) => `
          <li class="${test.success ? "success" : "failure"}">
            <strong>${test.action.name}</strong>: ${
              test.success ? "Passed" : "Failed"
            }
            ${test.error ? `<pre>${test.error}</pre>` : ""}
          </li>
        `,
          )
          .join("")}
      </ul>

      <!-- Include any other relevant context you need -->

    </body>
    </html>
  `;
}
// reports should show a high level of "3 of 5 tests passed"
// It should help us understand whether we should be improving the prompts, fixing the code, or both

// TODO:
// [ ] add more other stuff here (more recipes)
// [ ] generate a report with: what the prompts were
// [x] have a baby dsl for tests???
// [ ] recipes -> scenarios
// tests = [
//   ["click", [("button", { name: "Add New Kitty" }], {timeout: 250}, "click the cat"]
//   ["click", [("button", { name: "Add New Kitty" }], {timeout: 250}]
//   ["click", [("button", { name: "Add New Kitty" }], {timeout: 250}]
// ];

import { actions as counterActions } from "./recipes/counters.newspec.actions.ts";
const counterReport = await testOneRecipe("counters", counterActions);

console.log(JSON.stringify(counterReport, null, 2));

// FIXME(jake): make this dynamic
const scenarioName = "scenario-abc123";
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const reportDir = join("results", scenarioName, timestamp);

await ensureDir(reportDir);
const reportHtml = generateReportHtml(counterReport);
const reportPath = join(reportDir, "report.html");
await Deno.writeTextFile(reportPath, reportHtml);
const reportJsonPath = join(reportDir, "report.json");
await Deno.writeTextFile(
  reportJsonPath,
  JSON.stringify(counterReport, null, 2),
);

const recipe = "counters";
// Copy original source
await Deno.copyFile(
  join(recipeDir, `${recipe}.tsx`),
  join(reportDir, `${recipe}.tsx`),
);

// Copy original spec
await Deno.copyFile(
  join(recipeDir, `${recipe}.ogspec.md`),
  join(reportDir, `${recipe}.ogspec.md`),
);

// Copy working spec
await Deno.copyFile(
  join(recipeDir, `${recipe}.newspec.md`),
  join(reportDir, `${recipe}.newspec.md`),
);

// Copy actions
await Deno.copyFile(
  join(recipeDir, `${recipe}.newspec.actions.ts`),
  join(reportDir, `${recipe}.newspec.actions.ts`),
);

// Copy generated source if it exists
if (counterReport["generatedSrc"]) {
  const generatedSrcPath = join(reportDir, `generated-${recipe}.tsx`);
  await Deno.writeTextFile(generatedSrcPath, counterReport["generatedSrc"]);
}
