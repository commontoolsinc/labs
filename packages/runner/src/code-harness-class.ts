import type { ICodeHarness, IRuntime } from "./runtime.ts";
import { UnsafeEvalRuntime } from "./harness/eval-runtime.ts";
import type { Runtime as HarnessRuntime, RuntimeFunction } from "./harness/runtime.ts";
import { Recipe } from "@commontools/builder";

export class CodeHarness implements ICodeHarness {
  readonly runtime: IRuntime;
  private harnessRuntime: HarnessRuntime;

  constructor(runtime: IRuntime) {
    this.runtime = runtime;
    // Create the actual runtime instance for code execution
    this.harnessRuntime = new UnsafeEvalRuntime();
  }

  async compile(source: string): Promise<Recipe | undefined> {
    return this.harnessRuntime.compile(source);
  }

  getInvocation(source: string): RuntimeFunction {
    return this.harnessRuntime.getInvocation(source);
  }

  eval(code: string, context?: any): any {
    // For backward compatibility, treat evaluate as compile
    return this.compile(code);
  }

  mapStackTrace(stack: string): string {
    return this.harnessRuntime.mapStackTrace(stack);
  }

  addEventListener(event: string, handler: Function): void {
    this.harnessRuntime.addEventListener(event, handler as EventListener);
  }

  removeEventListener(event: string, handler: Function): void {
    this.harnessRuntime.removeEventListener(event, handler as EventListener);
  }

  // Expose additional harness methods if needed
  get harness(): HarnessRuntime {
    return this.harnessRuntime;
  }
}