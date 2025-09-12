import { ProgramResolver, Source } from "./interface.ts";
import { dirname, join } from "@std/path";

// Extend `EngineProgramResolver` to add the necessary 3P module
// types when needed, but otherwise lazily crawl the filesystem
// while walking source files
export class FileSystemProgramResolver implements ProgramResolver {
  private fsRoot: string;
  private _main: Source;
  constructor(mainPath: string) {
    this.fsRoot = dirname(mainPath);
    this._main = {
      name: mainPath.substring(this.fsRoot.length),
      contents: Deno.readTextFileSync(mainPath),
    };
  }

  main(): Source {
    return this._main;
  }

  resolveSource(specifier: string): Promise<Source | undefined> {
    if (specifier && specifier[0] === "/") {
      const absPath = join(
        this.fsRoot,
        specifier.substring(1, specifier.length),
      );
      return Promise.resolve({
        name: specifier,
        contents: Deno.readTextFileSync(absPath),
      });
    }
    return Promise.resolve(undefined);
  }
}
