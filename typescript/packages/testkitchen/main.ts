import { join } from "@std/path";
import { exists } from "@std/fs";
import { iterate } from "./prompts.ts";
import { chromium, Page } from "playwright";
import { Action, ActionResult } from "./recipes/actions.ts";
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

  const loadUrl = `http://localhost:5173/newRecipe?src=${
    encodeURIComponent(
      srcUrl,
    )
  }`;

  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  const loaded = new Promise<string | true>((resolve) => {
    page.on("console", (msg) => {
      if (msg.type() === "error") {
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

// TODO:
// [ ] add more other stuff here (more recipes)
// [ ] generate a report with: what the prompts were
// [ ] have a dsl for tests???
// tests = [
//   ["click", [("button", { name: "Add New Kitty" }], {timeout: 250}, "click the cat"]
//   ["click", [("button", { name: "Add New Kitty" }], {timeout: 250}]
//   ["click", [("button", { name: "Add New Kitty" }], {timeout: 250}]
// ];

import { actions as counterActions } from "./recipes/counters.newspec.actions.ts";
const counterReport = await testOneRecipe("counters", counterActions);

console.log(JSON.stringify(counterReport, null, 2));
