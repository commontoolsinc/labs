import { Command } from "@cliffy/command";
import { join } from "@std/path";
import { exists } from "@std/fs";

const recipesPath = join(Deno.cwd(), "../lookslike-high-level/src/recipes");

await new Command()
  .name("tk")
  .version("0.0.1")
  .description("Test Kitchen CLI")
  .arguments("<recipe:string>")
  .action(async (_options: any, recipe: string) => {
    const recipeDir = join(recipesPath);

    const sourceCodePath = join(recipeDir, `${recipe}.tsx`);
    const specPath = join(recipeDir, `${recipe}.spec.md`);
    const playwrightScriptPath = join(recipeDir, `${recipe}.playwright.ts`);
    const exampleDataPath = join(recipeDir, `${recipe}.exampledata.json`);

    console.log("recipePath", recipesPath);
    console.log("sourceCodePath", sourceCodePath);

    const files = [
      sourceCodePath,
      specPath,
      playwrightScriptPath,
      exampleDataPath,
    ];

    for (const file of files) {
      if (!(await exists(file))) {
        console.error(`File not found: ${file}`);
        Deno.exit(1);
      }
    }

    const sourceCode = await Deno.readTextFile(sourceCodePath);
    const spec = await Deno.readTextFile(specPath);
    const playwrightScript = await Deno.readTextFile(playwrightScriptPath);
    const exampleData = await Deno.readTextFile(exampleDataPath);

    const command = new Deno.Command("deno", {
      args: [
        "run",
        "-A",
        "--node-modules-dir",
        "npm:playwright",
        "test",
        "example.ts",
        // playwrightScriptPath,
        "--config",
        "playwright.config.ts",
      ],
      stdout: "inherit",
      stderr: "inherit",
    });

    const { success } = await command.output();

    if (!success) {
      console.error("Playwright script execution failed.");
      Deno.exit(1);
    }

    console.log("Playwright script executed successfully.");
  })
  .parse(Deno.args);
