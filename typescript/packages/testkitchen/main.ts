import { join } from "@std/path";
import { exists } from "@std/fs";
import { iterate } from "./prompts.ts";
import { chromium, Page } from "playwright";
const recipeDir = join(Deno.cwd(), "recipes");

type Iteration = Record;

async function testIterate(
  recipe: string,
  tests: (page: Page) => Promise,
): Promise {
  let info: Iteration = {};

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

  console.log("loading", loadUrl);
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  const loaded = new Promise<string | true>(resolve => {
    page.on("console", msg => {
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

  info["tests"] = await tests(page);

  await browser.close();

  return info;
}

// TODO:
// [ ] add more other stuff here (more recipes)
// [ ] generate a report with: what the prompts were
const report = await testIterate("counters", async (page: Page): Promise => {
  try {
    await page.getByRole("button", { name: "Add New Kitty" }).click({
      timeout: 250,
    });
  } catch (error) {
    return "Error: Add New Kitty button click failed - " + error.message;
  }

  try {
    await page.getByRole("button", { name: "Pat random kitty" }).click({
      timeout: 250,
    });
  } catch (error) {
    return "Error: Pat random kitty button click failed - " + error.message;
  }

  try {
    await page.getByRole("button", { name: "Pat the kitty" }).click({
      timeout: 250,
    });
  } catch (error) {
    return "Error: Pat the kitty button click failed - " + error.message;
  }

  return "success"; // Return success if all clicks are successful
});

console.log(JSON.stringify(report, null, 2));
