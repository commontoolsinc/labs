import { join } from "@std/path";
import { exists } from "@std/fs";
import { iterate } from "./prompts.ts";
import { chromium, Page } from "playwright";
import { Action, ActionResult } from "./actions.ts";
import { ensureDir } from "@std/fs";

const scenarioDir = join(Deno.cwd(), "scenarios");
async function runRecipeActions(page: Page, actions: Action[]) {
  const rv = [] as ActionResult[];
  let action;
  for (action of actions) {
    if (action.type === "click") {
      const startTime = performance.now();
      try {
        await page.getByRole(...action.args).click({ timeout: 500 });
        rv.push({ 
          success: true, 
          action,
          duration: performance.now() - startTime 
        });
      } catch (e) {
        rv.push({
          error: e instanceof Error ? e.message : JSON.stringify(e),
          success: false,
          action,
          duration: performance.now() - startTime
        });
      }
    }
  }
  return rv;
}

async function testOneScenario(scenario: string, actions: Action[]): Promise {
  let info = {} as any;

  // TODO: remove any old generated source

  info["name"] = scenario;

  info["originalSrc"] = await Deno.readTextFile(
    join(scenarioDir, scenario, "original.tsx"),
  );
  info["originalSpec"] = await Deno.readTextFile(
    join(scenarioDir, scenario, "ogspec.md"),
  );
  info["workingSpec"] = await Deno.readTextFile(
    join(scenarioDir, scenario, "newspec.md"),
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

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const tmpSrcName = `${scenario}-${timestamp}`;
  const newSrcPath = join("tmp", `${tmpSrcName}.tsx`);
  await Deno.writeTextFile(newSrcPath, info["generatedSrc"]);
  // FIXME(ja): we should stand up a server to serve interm reports as well as generated content
  const srcUrl = `http://localhost:8000/tmp/${tmpSrcName}.tsx`;
  const loadUrl = `http://localhost:5173/newRecipe?src=${
    encodeURIComponent(
      srcUrl,
    )
  }`;

  // const browser = await chromium.launch({ headless: false });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const loaded = new Promise<string | true>((resolve) => {
    page.on("console", (msg) => {
      if (msg.type() == "error") {
        if (msg.text().includes("Errors in recipe:")) {
          // TODO(jake): make this expose the full error/stack trace??
          const error = msg.text().split("Errors in recipe: ")[1];
          console.log(`Recipe failed to load, with error: "${error}"`);

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
    await browser.close();
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

// P2: click to see code diff
// P2: save screenshots for each actions / initial state of recipe, ending state
// P2: save console logs/errors for each actions
// P2: timings!!!!  (we should store the timings)
function generateReportHtml(results: any, reportName: string): string {
  const reports: string[] = [];
  
  // Calculate pass/fail stats
  const total = results.length;
  const passed = results.filter((info: any) => 
    !info.compileError && 
    info.tests?.every((test: any) => test.success)
  ).length;
  const allPassed = passed === total;
  const resultsColor = allPassed ? "green" : "red";
  
  let info;
  for (info of results) {
    const report = `<div class="scenario" style="border: 1px solid black; padding: 10px; margin: 10px;">

    <h2>${info.name}</h2>
    ${
      info.compileError
        ? `<h2>Compile Error</h2><br/><pre>${info.compileError}</pre>`
        : ""
    }

    ${
      info.tests &&info.tests.length > 0
        ? `
            <h2>Actions</h2>
<ul>
      ${
        info.tests
          .map(
            (test: any) => `
        <li class="${test.success ? "success" : "failure"}">
        <span>
          <strong>${test.action.name}</strong>: ${
              test.success ? "Passed" : "Failed"
            }
            <span style="font-family: monospace;">
              ${test.duration ? `(${test.duration.toFixed(2)}ms)` : ""}
            </span>
        </span>

          ${test.error ? `<pre>${test.error}</pre>` : ""}
        </li>
      `,
          )
          .join("")
      }
      </ul>`
        : ""
    }
    </div>`;
    reports.push(report);
  }

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Summary Report for ${reportName}</title>
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

    <h1>Test Report for ${reportName}</h1>
    <h2 style="color: ${resultsColor}">Results: ${passed}/${total} scenarios passed</h2>
    <p>Generated at: ${new Date().toLocaleString()}</p>
      ${reports.join("\n")}

    </body>
    </html>
  `;
}
// reports should show a high level of "3 of 5 tests passed"
// It should help us understand whether we should be improving the prompts, fixing the code, or both

// TODO:
// [x] add more other stuff here (more recipes)
// [ ] generate a report with: what the prompts were
// [x] have a baby dsl for tests???
// [ ] recipes -> scenarios
// tests = [
//   ["click", [("button", { name: "Add New Kitty" }], {timeout: 250}, "click the cat"]
//   ["click", [("button", { name: "Add New Kitty" }], {timeout: 250}]
//   ["click", [("button", { name: "Add New Kitty" }], {timeout: 250}]
// ];

// TWO WAYS TO RUN:

// 1. iterating on the `prompts.ts` ... (prompting)
//   x P0: want to run all the scenarios
//   - P0: see a "all scenarios report: 3/5 scenarios pass, details"
//   - P3: write report to disk each time something changes ... this way live-server (node) will just give us live reporting
//   x P0 /reports/:date
//   x P1 /reports/latest -> symlink to the last reports/:date

// 2. Iterating on a scenario (fixate - pytest -f)
//   - P2 only re-run the given sceneraio, only see the report on that sceneario

const results = [];

import { actions as kittyActions } from "./scenarios/pet-kitties/actions.ts";
results.push(await testOneScenario("pet-kitties", kittyActions));

import { actions as anotherActions } from "./scenarios/another-counters/actions.ts";
results.push(await testOneScenario("another-counters", anotherActions));

const reportName = "run"; // TODO: user should be allowed to provide
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const reportDir = join("reports", `${reportName}-${timestamp}`);

await ensureDir(reportDir);
const reportHtml = generateReportHtml(results, reportName);

const reportPath = join(reportDir, "report.html");
await Deno.writeTextFile(reportPath, reportHtml);
const reportJsonPath = join(reportDir, "report.json");
await Deno.writeTextFile(reportJsonPath, JSON.stringify(results, null, 2));
console.log('INFO', JSON.stringify(results, null, 2))
const latestLinkPath = join("reports", "latest");

if (await exists(latestLinkPath)) {
  await Deno.remove(latestLinkPath);
}

// Use the relative directory name only, not the full path
const relativeReportDir = `run-${timestamp}`;
await Deno.symlink(relativeReportDir, latestLinkPath, { type: "dir" });

// const recipe = "counters";
// // Copy original source
// await Deno.copyFile(
//   join(scenarioDir, `${recipe}.tsx`),
//   join(reportDir, `${recipe}.tsx`),
// );

// // Copy original spec
// await Deno.copyFile(
//   join(scenarioDir, `${recipe}.ogspec.md`),
//   join(reportDir, `${recipe}.ogspec.md`),
// );

// // Copy working spec
// await Deno.copyFile(
//   join(scenarioDir, `${recipe}.newspec.md`),
//   join(reportDir, `${recipe}.newspec.md`),
// );

// // Copy actions
// await Deno.copyFile(
//   join(scenarioDir, `${recipe}.newspec.actions.ts`),
//   join(reportDir, `${recipe}.newspec.actions.ts`),
// );

// // Copy generated source if it exists
// if (counterReport["generatedSrc"]) {
//   const generatedSrcPath = join(reportDir, `generated-${recipe}.tsx`);
//   await Deno.writeTextFile(generatedSrcPath, counterReport["generatedSrc"]);
// }
