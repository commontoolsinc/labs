import { UnsafeEvalRuntime } from "./eval-runtime.ts";
export { UnsafeEvalRuntime };
export { type Runtime } from "./runtime.ts";
export { ConsoleMethod } from "./console.ts";

export const runtime = new UnsafeEvalRuntime();
