import { describe, it } from "@std/testing/bdd";
import { commonTypeScriptTransformer } from "../src/transform.ts";
import { assert } from "@std/assert";
import * as ts from "typescript";

describe("commonTypeScriptTransformer", () => {
  it("provides transforms if cts-enable", () => {
    const host = new TSHost(
      "/main.ts",
      `/// <cts-enable />
      export default 5;`,
    );
    const program = ts.createProgram(["/main.ts"], {}, host);
    assert(
      commonTypeScriptTransformer(program).length > 0,
      "transformers provided when '<cts-enable />' available.",
    );
  });
  it("does not provide transforms without cts-enable", () => {
    const host = new TSHost("/main.ts", `export default 5;`);
    const program = ts.createProgram(["/main.ts"], {}, host);
    assert(
      commonTypeScriptTransformer(program).length === 0,
      "no transformers when '<cts-enable />' not available.",
    );
  });
});

class TSHost implements ts.CompilerHost {
  constructor(public filename: string, public contents: string) {
  }
  getSourceFile(
    fileName: string,
    languageVersionOrOptions: ts.ScriptTarget | ts.CreateSourceFileOptions,
  ): ts.SourceFile | undefined {
    const sourceText = this.readFile(fileName);
    return sourceText !== undefined
      ? ts.createSourceFile(fileName, sourceText, languageVersionOrOptions)
      : undefined;
  }
  getDefaultLibFileName(options: ts.CompilerOptions): string {
    return "";
  }
  writeFile(filename: string, text: string): void {
    throw new Error("Method not implemented.");
  }
  getCurrentDirectory(): string {
    return "/";
  }
  getCanonicalFileName(fileName: string): string {
    return fileName;
  }
  useCaseSensitiveFileNames(): boolean {
    return true;
  }
  getNewLine(): string {
    return "\n";
  }
  fileExists(fileName: string): boolean {
    throw new Error("Method not implemented.");
  }
  readFile(filename: string) {
    return filename === this.filename ? this.contents : undefined;
  }
}
