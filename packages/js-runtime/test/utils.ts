import {
  JsScript,
  ProgramGraph,
  Source,
  UnsafeEvalJsValue,
  UnsafeEvalRuntime,
} from "../mod.ts";

export function execute(bundled: JsScript): UnsafeEvalJsValue {
  const runtime = new UnsafeEvalRuntime();
  const isolate = runtime.getIsolate("");
  return isolate.execute(bundled);
}

export class TestProgram implements ProgramGraph {
  private modules: Record<string, string>;
  private entryName: string;
  constructor(entryName: string, modules: Record<string, string>) {
    this.modules = modules;
    this.entryName = entryName;
  }

  entry(): Source {
    const entry = this.resolveSource(this.entryName);
    if (!entry) {
      throw new Error(`${this.entryName} not in modules.`);
    }
    return entry;
  }

  resolveSource(identifier: string): Source | undefined {
    const contents = this.modules[identifier];
    if (!contents) return undefined;
    return { contents, name: identifier };
  }
}
