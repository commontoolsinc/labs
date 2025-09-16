import type { PatternIntegrationScenario } from "../pattern-harness.ts";

interface EchoArgs {
  message: string;
}

export const echoScenario: PatternIntegrationScenario<EchoArgs> = {
  name: "echo returns provided argument",
  module: new URL("./echo.pattern.ts", import.meta.url),
  exportName: "echoRecipe",
  argument: { message: "hello" },
  steps: [{ expect: [{ path: "message", value: "hello" }] }],
};

export const scenarios = [echoScenario];
