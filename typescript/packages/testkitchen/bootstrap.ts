import { join } from "@std/path";
import { exists } from "@std/fs";
import { iterate } from "./prompts.ts";

if (Deno.args.length !== 1) {
  console.error("Usage: deno run -A bootstrap.ts <scenario-name>");
  Deno.exit(1);
}

const scenarioName = Deno.args[0];
const scenarioDir = join(Deno.cwd(), "scenarios", scenarioName);

async function bootstrap() {
  // Check if scenario directory exists
  if (!await exists(scenarioDir)) {
    console.error(`Scenario directory not found: ${scenarioDir}`);
    Deno.exit(1);
  }

  // Define paths
  const ogSpecPath = join(scenarioDir, "ogspec.md");
  const newSpecPath = join(scenarioDir, "newspec.md");
  const originalPath = join(scenarioDir, "original.tsx");
  const newPath = join(scenarioDir, "new.tsx");

  // Check for required files
  if (!await exists(ogSpecPath)) {
    console.error(`Original spec file not found: ${ogSpecPath}`);
    Deno.exit(1);
  }

  const ogSpec = await Deno.readTextFile(ogSpecPath);

  // Check if we're doing initial creation or iteration
  const hasNewSpec = await exists(newSpecPath);
  const hasOriginal = await exists(originalPath);

  if (hasNewSpec && hasOriginal) {
    // We're doing an iteration
    console.log("Found newspec.md and original.tsx - generating iteration...");
    
    const newSpec = await Deno.readTextFile(newSpecPath);
    const originalSrc = await Deno.readTextFile(originalPath);

    const result = await iterate({
      originalSpec: ogSpec,
      originalSrc,
      workingSpec: newSpec,
    });

    if (result.generationError) {
      console.error("Error generating iteration:", result.generationError);
      Deno.exit(1);
    }

    if (!result.generatedSrc) {
      console.error("No code was generated for iteration");
      Deno.exit(1);
    }

    await Deno.writeTextFile(newPath, result.generatedSrc);
    console.log(`Successfully generated iterated code at: ${newPath}`);

  } else {
    // We're doing initial creation
    console.log("Generating initial recipe...");
    
    const result = await iterate({
      originalSpec: ogSpec,
      originalSrc: "", // No original source for bootstrap
      workingSpec: ogSpec, // Use same spec for working spec in bootstrap
    });

    if (result.generationError) {
      console.error("Error generating code:", result.generationError);
      Deno.exit(1);
    }

    if (!result.generatedSrc) {
      console.error("No code was generated");
      Deno.exit(1);
    }

    await Deno.writeTextFile(originalPath, result.generatedSrc);
    console.log(`Successfully generated initial recipe at: ${originalPath}`);
  }
}

bootstrap().catch((error) => {
  console.error("Bootstrap failed:", error);
  Deno.exit(1);
});
