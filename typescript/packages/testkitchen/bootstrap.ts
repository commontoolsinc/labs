import { join } from "@std/path";
import { exists } from "@std/fs";
import { iterate } from "./prompts.ts";

if (Deno.args.length !== 1) {
  console.error("Usage: deno run --allow-read --allow-write --allow-net bootstrap.ts <scenario-name>");
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

  // Read spec file
  const specPath = join(scenarioDir, "ogspec.md");
  if (!await exists(specPath)) {
    console.error(`Spec file not found: ${specPath}`);
    Deno.exit(1);
  }

  const spec = await Deno.readTextFile(specPath);
  
  // Generate the recipe code
  const result = await iterate({
    originalSpec: spec,
    originalSrc: "", // No original source for bootstrap
    workingSpec: spec, // Use same spec for working spec in bootstrap
  });

  if (result.generationError) {
    console.error("Error generating code:", result.generationError);
    Deno.exit(1);
  }

  if (!result.generatedSrc) {
    console.error("No code was generated");
    Deno.exit(1);
  }

  // Write the generated code
  const outputPath = join(scenarioDir, "original.tsx");
  await Deno.writeTextFile(outputPath, result.generatedSrc);
  
  console.log(`Successfully generated recipe code at: ${outputPath}`);
}

bootstrap().catch((error) => {
  console.error("Bootstrap failed:", error);
  Deno.exit(1);
});
