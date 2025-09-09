import {
  getTypeScriptEnvironmentTypes,
  InMemoryProgram,
  JsScript,
  TypeScriptCompiler,
} from "@commontools/js-runtime";
import { StaticCache } from "@commontools/static";

const types = await getTypeScriptEnvironmentTypes(new StaticCache());

export async function compile(
  code: string | Record<string, string>,
): Promise<JsScript> {
  const compiler = new TypeScriptCompiler(types);
  const program = new InMemoryProgram(
    "/main.tsx",
    typeof code === "string"
      ? {
        "/main.tsx": code,
      }
      : code,
  );
  const compiled = await compiler.resolveAndCompile(program, {
    bundleExportAll: true,
  });
  return compiled;
}
