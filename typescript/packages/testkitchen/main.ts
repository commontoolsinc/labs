import { join } from "@std/path";
import { exists } from "@std/fs";
import { iterate } from "./prompts.ts";

const recipeDir = join(Deno.cwd(), "recipes");

async function counters() {
  const recipe = "counters";
  const originalSrc = await Deno.readTextFile(join(recipeDir, `${recipe}.tsx`));
  const originalSpec = await Deno.readTextFile(
    join(recipeDir, `${recipe}.ogspec.md`),
  );
  const workingSpec = await Deno.readTextFile(
    join(recipeDir, `${recipe}.newspec.md`),
  );
    // const exampleData = await Deno.readTextFile();

  const { src } = await iterate({ originalSrc, originalSpec, workingSpec });
  console.log(src);
  await Deno.writeTextFile(join(recipeDir, `new.tsx`), src);
  const srcUrl = `http://localhost:8000/new.tsx`;
  // const playwrightScriptPath = join(recipeDir, `${recipe}.playwright.ts`);
  // const exampleDataPath = join(recipeDir, `${recipe}.exampledata.json`);
  const loadUrl = `http://localhost:5173/newRecipe?src=${
    encodeURIComponent(
      srcUrl,
    )
  }`;
  console.log(loadUrl);
}

counters();
