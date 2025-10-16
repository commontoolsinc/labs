import {
  getTypeScriptEnvironmentTypes,
  InMemoryProgram,
  JsScript,
  TypeScriptCompiler,
} from "@commontools/js-runtime";
import { TestStaticCache } from "@commontools/static/utils";

const types = await getTypeScriptEnvironmentTypes(new TestStaticCache());

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
