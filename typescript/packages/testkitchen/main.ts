import { join } from "@std/path";
import { exists } from "@std/fs";
import { LLM_CAPABILITIES} from "./prompts.ts";
import { chromium, Page } from "playwright";
import { Action, ActionResult } from "./types.ts";
import { ensureDir } from "@std/fs";
import { startTempServer } from "./hono-http.ts";
import { diff } from "@libs/diff";

const evalDir = join(Deno.cwd(), "evals");
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const reportName = `run`;

const reportDir = join("reports", `${reportName}-${timestamp}`);
await ensureDir(reportDir);

async function runRecipeActions(page: Page, actions: Action[]): Promise<ActionResult[]> {
  const rv = [] as ActionResult[];
  
  // Initial page load delay instead of networkidle
  await page.waitForTimeout(2000);
  console.log('Page loaded, starting actions...');

  for (const [index, action] of actions.entries()) {
    const actionDir = join(reportDir, "media", `action-${index}`);
    await ensureDir(actionDir);
    
    // Screenshot before action
    await page.screenshot({ 
      path: join(actionDir, "before.png"),
      fullPage: true 
    });

    const startTime = performance.now();
    try {
      switch (action.type) {
        case "click": {
          const clickAction = action as ClickAction;
          await page.getByRole(...clickAction.args).click({ timeout: 2500 });
          break;
        }
        case "assert": {
          const assertAction = action as AssertAction;
          const element = page.getByRole(...assertAction.args);
          const isVisible = await element.isVisible();

          if (!isVisible) {
            if (assertAction.args[1].notVisible) {
              // This is ok
              continue;
            }
            throw new Error(`Assertion failed: Could not find element with role ${assertAction.args[0]} and properties ${JSON.stringify(assertAction.args[1])}`);
          }

          if (assertAction.args[1].expected) {
            const text = await element.textContent();
            if (text !== assertAction.args[1].expected) {
              throw new Error(`Assertion failed: Expected text "${assertAction.args[1].expected}" but got "${text}"`);
            }
          }

          if (assertAction.args[1].notVisible) {
            const isVisible = await element.isVisible();
            if (isVisible) {
              throw new Error(`Assertion failed: Expected element with role ${assertAction.args[0]} and properties ${JSON.stringify(assertAction.args[1])} to be hidden but it is visible`);
            }
          }

          break;
        }
        default: {
          const _exhaustiveCheck: never = action;
          throw new Error(`Unknown action type: ${(action as any).type}`);
        }
      }

      const endTime = performance.now();
      const duration = endTime - startTime;
      // Small delay to let any animations complete
      await page.waitForTimeout(1000);
      
      // Screenshot after action
      await page.screenshot({ 
        path: join(actionDir, "after.png"),
        fullPage: true 
      });

      rv.push({ 
        success: true, 
        action,
        duration,
        screenshots: {
          before: `media/action-${index}/before.png`,
          after: `media/action-${index}/after.png`
        }
      });
    } catch (e) {
      // Still capture the after screenshot on failure
      await page.screenshot({ 
        path: join(actionDir, "after.png"),
        fullPage: true 
      });

      rv.push({
        error: e instanceof Error ? e.message : JSON.stringify(e),
        success: false,
        action,
        duration: performance.now() - startTime,
        screenshots: {
          before: `media/action-${index}/before.png`,
          after: `media/action-${index}/after.png`
        }
      });
    }
  }
  return rv;
}

async function safeReadFile(path: string, defaultValue: string = ""): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      console.warn(`Warning: Error reading ${path}:`, error);
    }
    return defaultValue;
  }
}

async function testOneScenario(evalName: string, scenario: string, actions: Action[]): Promise<any> {
  let info = {} as any;

  info["name"] = scenario;
  info["eval"] = evalName;

  const llmHandler = LLM_CAPABILITIES[evalName].handler;
  const scenarioPath = join(evalDir, evalName, scenario);

  info["originalSpec"] = await safeReadFile(join(scenarioPath, "original-spec.md"));
  info["originalSrc"] = await safeReadFile(join(scenarioPath, "original.tsx"));
  info["workingSpec"] = await safeReadFile(join(scenarioPath, "new-spec.md"));
  info["errors"] = await safeReadFile(join(scenarioPath, "errors.txt"));
  info["userPrompt"] = await safeReadFile(join(scenarioPath, "user-prompt.txt"));
  info["actions"] = actions;

  // For text generation evals, check if we have an expected output file
  const expectedOutputPath = join(scenarioPath, "expected-output.md");
  const hasExpectedOutput = await exists(expectedOutputPath);
  
  if (hasExpectedOutput) {
    // This is a text generation test
    const expectedOutput = await safeReadFile(expectedOutputPath);
    
    const payload = await llmHandler({
      originalSrc: info["originalSrc"],
      originalSpec: info["originalSpec"],
      workingSpec: info["workingSpec"],
      userPrompt: info["userPrompt"],
    });

    info = { ...payload, ...info };

    // Compare generated text with expected output
    if (info["generatedText"]) {
      info["tests"] = [{
        success: info["generatedText"].trim() === expectedOutput.trim(),
        action: {
          type: "assert",
          name: "Assert generated text is equal to expected text.",
          args: ["text", { expected: expectedOutput, actual: info["generatedText"], diff: diff(expectedOutput.trim(), info["generatedText"].trim()) }],
        }
      }];
    }
    
    return info;
  }

  // Rest of the existing code for codegen tests...
  const payload = await llmHandler({
    originalSrc: info["originalSrc"],
    originalSpec: info["originalSpec"],
    workingSpec: info["workingSpec"],
    errors: info["errors"],
    userPrompt: info["userPrompt"],
  });

  info = { ...payload, ...info };

  if (info["generatedSrc"] === undefined) {
    return info;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const tmpSrcName = `${scenario}-${timestamp}`;
  const newSrcPath = join("tmp", `${tmpSrcName}.tsx`);
  await Deno.writeTextFile(newSrcPath, info["generatedSrc"]);
  
  const port = await startTempServer();
  const srcUrl = `http://localhost:${port}/tmp/${tmpSrcName}.tsx`;
  const loadUrl = `http://localhost:5173/newRecipe?src=${encodeURIComponent(srcUrl)}`;

  // const browser = await chromium.launch({ headless: false });
  const browser = await chromium.launch({ headless: true });
  const mediaDir = join(reportDir, "media");
  await ensureDir(mediaDir);
  const videoPath = join(mediaDir, `${scenario}.webm`);

  // Create a new context with video recording enabled
  const context = await browser.newContext({
    recordVideo: {
      dir: mediaDir,
      size: { width: 1280, height: 720 }
    }
  });
  
  // Create page from this context
  const page = await context.newPage();

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

      // NOTE: This relies on the existence of a console.log message from the window manager, in the code that handles /newRecipe
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


  // Run the tests
  info["tests"] = await runRecipeActions(page, info["actions"]);

  if (info["tests"] === true) {
    info["success"] = new Date();
  }

  // Wait for the page to finish any pending actions
  await page.waitForTimeout(1000);
  
  // Get video before closing anything
  const video = page.video();
  
  // Close page first, but keep context alive
  await page.close();
  
  // Now save the video
  if (video) {
    await video.saveAs(videoPath);
    // Delete the original UUID-named file
    await video.delete();
  }

  // Close the context after saving
  await context.close();
  
  info["videoPath"] = `media/${scenario}.webm`;
  
  await browser.close();
  return info;
}

// P2: click to see code diff
// x P2: save screenshots for each actions / initial state of recipe, ending state
// P2: save console logs/errors for each actions
// x P2: timings!!!!  (we should store the timings)
function generateReportHtml(results: any, reportName: string): string {
  // Group results by eval
  const evalGroups = results.reduce((acc: {[key: string]: any[]}, result: any) => {
    acc[result.eval] = acc[result.eval] || [];
    acc[result.eval].push(result);
    return acc;
  }, {});
  
  // Calculate overall pass/fail stats
  const total = results.length;
  const passed = results.filter((info: any) => 
    !info.compileError && 
    info.tests?.every((test: any) => test.success)
  ).length;
  const allPassed = passed === total;
  const resultsColor = allPassed ? "green" : "red";
  
  const evalReports = Object.entries(evalGroups).map(([evalName, evalResults]) => {
    const evalPassed = evalResults.filter((info: any) => 
      !info.compileError && 
      info.tests?.every((test: any) => test.success)
    ).length;
    
    const scenarios = evalResults.map(info => `
      <div class="scenario" style="border: 1px solid black; padding: 10px; margin: 10px;">
        <h3>${info.name}</h3>
        
        <details>
          <summary>Video Recording</summary>
          ${info.videoPath ? `
            <video width="800" controls>
              <source src="${info.videoPath}" type="video/webm">
              Your browser does not support the video tag.
            </video>
          ` : ''}
        </details>
        
        ${info.compileError
          ? `<h3>Compile Error</h3><br/><pre>${info.compileError}</pre>`
          : ""}

        ${
          info.tests && info.tests.length > 0
            ? `
                <h3>Actions</h3>
                ${info.tests.map((test: any, index: number) => `
                  <div class="test-action">
                    <h4 class="${test.success ? "success" : "failure"}">
                      Action ${index + 1}: ${test.action.name} 
                      ${test.duration ? `
                        <span style="font-size: 0.8em; font-family: monospace;">(${test.duration.toFixed(2)}ms)</span>
                      ` : ''}
                    </h4>
                    ${test.error ? `<p class="error">Error: ${test.error}</p>` : ''}
                    
                    ${test.screenshots ? `
                      <details>
                        <summary>Screenshots</summary>
                        <div class="screenshots" style="display: flex; gap: 10px; margin-top: 10px;">
                          <div>
                            <h4>Before</h4>
                            <img src="${test.screenshots.before}" style="max-width: 300px; border: 1px solid #ccc;" />
                          </div>
                          <div>
                            <h4>After</h4>
                            <img src="${test.screenshots.after}" style="max-width: 300px; border: 1px solid #ccc;" />
                          </div>
                        </div>
                      </details>
                    ` : ''}
                    
                    ${test.action.args?.[1]?.diff ? `
                      <details>
                        <summary>Text Diff</summary>
                        <pre class="diff">${test.action.args[1].diff}</pre>
                      </details>
                    ` : ''}
                  </div>
                `).join('\n')}
            `
            : ""
        }
      </div>
    `).join('\n');

    return `
      <div class="eval-group">
        <h2>
          ${evalName} 
          <span style="font-size: 0.8em; color: ${evalPassed === evalResults.length ? 'green' : 'red'}">
            (${evalPassed}/${evalResults.length} passed)
          </span>
        </h2>
        ${scenarios}
      </div>
    `;
  }).join('\n');

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Summary Report for ${reportName}</title>
      <style>
        body { font-family: sans-serif; padding: 20px; }
        h1, h2, h3, h4 { color: #333; }
        .success { color: green; }
        .failure { color: red; }
        .error { color: red; margin: 10px 0; }
        pre { background-color: #f0f0f0; padding: 10px; }
        .test-action { margin: 20px 0; padding: 10px; border: 1px solid #eee; }
        .screenshots img { box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
        details { margin: 10px 0; }
        summary { cursor: pointer; padding: 5px; background: #f5f5f5; }
        summary:hover { background: #eee; }
        .eval-group { 
          margin: 30px 0;
          padding: 20px;
          background: #f8f8f8;
          border-radius: 8px;
        }
      </style>
    </head>
    <body>
      <center>
        <img src="testkitchen.png" style="width: 350px; height: 350px" />
      </center>

      <h1>Test Report for ${reportName}</h1>
      <h2 style="color: ${resultsColor}">Overall Results: ${passed}/${total} scenarios passed</h2>
      <p>Generated at: ${new Date().toLocaleString()}</p>
      ${evalReports}
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
// [x] recipes -> scenarios
// tests = [
//   ["click", [("button", { name: "Add New Kitty" }], {timeout: 250}, "click the cat"]
//   ["click", [("button", { name: "Add New Kitty" }], {timeout: 250}]
//   ["click", [("button", { name: "Add New Kitty" }], {timeout: 250}]
// ];

// TWO WAYS TO RUN:

// 1. iterating on the `prompts.ts` ... (prompting)
//   x P0: want to run all the scenarios
//   x P0: see a "all scenarios report: 3/5 scenarios pass, details"
//   x P3: write report to disk each time something changes ... this way live-server (node) will just give us live reporting
//   x P0 /reports/:date
//   x P1 /reports/latest -> symlink to the last reports/:date

// 2. Iterating on a scenario (fixate - pytest -f)
//   - P2 only re-run the given sceneraio, only see the report on that sceneario

async function findScenarios(evalDir: string, evalFilter?: string, scenarioFilter?: string): Promise<Array<{eval: string, scenario: string, actionsPath: string}>> {
  const scenarios = [];
  
  for await (const evalEntry of Deno.readDir(evalDir)) {
    if (!evalEntry.isDirectory || (evalFilter && evalEntry.name !== evalFilter)) continue;
    
    const evalPath = join(evalDir, evalEntry.name);
    for await (const scenarioEntry of Deno.readDir(evalPath)) {
      if (!scenarioEntry.isDirectory || (scenarioFilter && scenarioEntry.name !== scenarioFilter)) continue;
      
      const actionsPath = join(evalPath, scenarioEntry.name, "actions.ts");
      if (await exists(actionsPath)) {
        scenarios.push({
          eval: evalEntry.name,
          scenario: scenarioEntry.name,
          actionsPath
        });
      }
    }
  }
  
  return scenarios;
}

// Get command line args
const evalFilter = Deno.args[0];
const scenarioFilter = Deno.args[1];

const scenarios = await findScenarios(evalDir, evalFilter, scenarioFilter);

if (scenarios.length === 0) {
  console.log("No scenarios found matching filters!");
  Deno.exit(1);
}

const results = [];

for (const scenario of scenarios) {
  console.log(`Running ${scenario.eval}/${scenario.scenario}...`);
  
  // Dynamic import of actions
  const { actions } = await import(scenario.actionsPath);
  results.push(await testOneScenario(scenario.eval, scenario.scenario, actions));
}

const reportHtml = generateReportHtml(results, reportName);

const reportPath = join(reportDir, "report.html");
await Deno.writeTextFile(reportPath, reportHtml);
const reportJsonPath = join(reportDir, "report.json");
await Deno.writeTextFile(reportJsonPath, JSON.stringify(results, null, 2));
// console.log('INFO', JSON.stringify(results, null, 2))
const latestLinkPath = join("reports", "latest");

const logoPath = join(Deno.cwd(), "testkitchen.png");
if (await exists(logoPath)) {
  await Deno.copyFile(logoPath, join(reportDir, "testkitchen.png"));
} else {
  console.warn("Warning: testkitchen.png not found in project root");
}


if (await exists(latestLinkPath)) {
  await Deno.remove(latestLinkPath);
}

// Use the relative directory name only, not the full path
const relativeReportDir = `run-${timestamp}`;
await Deno.symlink(relativeReportDir, latestLinkPath, { type: "dir" });

// Print summary and exit
const total = results.length;
const passed = results.filter(info => 
  !info.compileError && 
  info.tests?.every(test => test.success)
).length;

console.log("\nTest Summary:");
console.log("=============");
console.log(`Scenarios: ${passed}/${total} passed`);

for (const result of results) {
  const scenarioStatus = !result.compileError && 
    result.tests?.every(test => test.success) ? "✅" : "❌";
  
  console.log(`${scenarioStatus} ${result.eval}/${result.name}`);
  if (result.compileError) {
    console.log(`   Error: ${result.compileError}`);
  } else {
    console.log(`   Actions: ${result.tests?.filter(t => t.success).length}/${result.tests?.length} passed`);
  }
}

console.log(`\nReport written to: ${reportPath}`);

// Exit with success if all tests passed
Deno.exit(passed === total ? 0 : 1);


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
