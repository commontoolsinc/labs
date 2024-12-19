import { join } from "@std/path";
import { exists } from "@std/fs";
import { codeGenIteration, codeGenFirstRun } from "./prompts.ts";

if (Deno.args.length !== 2) {
  console.error("Usage: deno run -A bootstrap.ts <eval-name> <scenario-name>");
  Deno.exit(1);
}

const evalName = Deno.args[0];
const scenarioName = Deno.args[1];
const scenarioDir = join(Deno.cwd(), "evals", evalName, scenarioName);

async function bootstrap() {
  // Check if scenario directory exists
  if (!await exists(scenarioDir)) {
    console.error(`Scenario directory not found: ${scenarioDir}`);
    Deno.exit(1);
  }

  // Define paths based on new structure
  const originalSpecPath = join(scenarioDir, "original-spec.md");
  const newSpecPath = join(scenarioDir, "new-spec.md");
  const originalPath = join(scenarioDir, "original.tsx");
  const newPath = join(scenarioDir, "new.tsx");

  // Check for required files
  if (!await exists(originalSpecPath)) {
    console.error(`Original spec file not found: ${originalSpecPath}`);
    Deno.exit(1);
  }

  const originalSpec = await Deno.readTextFile(originalSpecPath);

  // Check if we're doing initial creation or iteration
  const hasNewSpec = await exists(newSpecPath);
  const hasOriginal = await exists(originalPath);

  if (hasNewSpec && hasOriginal) {
    // We're doing an iteration
    console.log("Found new-spec.md and original.tsx - generating iteration...");
    
    const newSpec = await Deno.readTextFile(newSpecPath);
    const originalSrc = await Deno.readTextFile(originalPath);

    const result = await codeGenIteration({
      originalSpec,
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
    
    const result = await codeGenFirstRun({
      originalSpec,
      originalSrc: "", // No original source for bootstrap
      workingSpec: originalSpec, // Use same spec for working spec in bootstrap
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
