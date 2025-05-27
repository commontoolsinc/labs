import {
  ExecutableJs,
  TsArtifact,
  UnsafeEvalJsValue,
  UnsafeEvalRuntime,
} from "../mod.ts";

export function unrollFiles(input: Record<string, string>): TsArtifact {
  const files = [];
  let entry;
  for (const [name, contents] of Object.entries(input)) {
    if (!entry) {
      entry = name;
    }
    files.push({ name, contents });
  }
  if (!entry) {
    throw new Error("No entry.");
  }
  return { entry, files };
}

export function execute(bundled: ExecutableJs): UnsafeEvalJsValue {
  const runtime = new UnsafeEvalRuntime();
  const isolate = runtime.getIsolate("");
  return isolate.execute(bundled);
}
