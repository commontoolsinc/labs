import { UnsafeEvalRuntime } from "./eval-runtime.ts";
export { UnsafeEvalRuntime };
//import { UnsafeEvalRuntimeMulti } from "./eval-runtime-multi.ts";
//export { UnsafeEvalRuntimeMulti };
export { type CtRuntime } from "./ct-runtime.ts";
export { ConsoleMethod } from "./console.ts";

export const runtime = new UnsafeEvalRuntime();
