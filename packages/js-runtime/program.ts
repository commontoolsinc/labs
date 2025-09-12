import { isDeno } from "@commontools/utils/env";
import { ProgramResolver, Source } from "./interface.ts";
import { dirname, join } from "@std/path";

export class InMemoryProgram implements ProgramResolver {
  private modules: Record<string, string>;
  private _main: string;
  constructor(main: string, modules: Record<string, string>) {
    this.modules = modules;
    this._main = main;
  }

  main(): Promise<Source> {
    const main = this.modules[this._main];
    if (!main) {
      throw new Error(`${this._main} not in modules.`);
    }
    return Promise.resolve({ name: this._main, contents: main });
  }

  resolveSource(identifier: string): Promise<Source | undefined> {
    const contents = this.modules[identifier];
    if (!contents) return Promise.resolve(undefined);
    return Promise.resolve({ contents, name: identifier });
  }
}

// Resolve a program using the file system.
// Deno-only.
export class FileSystemProgramResolver implements ProgramResolver {
  private fsRoot: string;
  private _main: Source;
  constructor(mainPath: string) {
    this.fsRoot = dirname(mainPath);
    this._main = {
      name: mainPath.substring(this.fsRoot.length),
      contents: this.#readFile(mainPath),
    };
  }

  main(): Promise<Source> {
    return Promise.resolve(this._main);
  }

  resolveSource(specifier: string): Promise<Source | undefined> {
    if (!specifier || specifier[0] !== "/") {
      return Promise.resolve(undefined);
    }
    const absPath = join(
      this.fsRoot,
      specifier.substring(1, specifier.length),
    );
    return Promise.resolve({
      name: specifier,
      contents: this.#readFile(absPath),
    });
  }

  #readFile(path: string): string {
    if (!isDeno()) {
      throw new Error(
        "FileSystemProgramResolver is not supported in this environment.",
      );
    }
    return Deno.readTextFileSync(path);
  }
}

// Resolve a program from HTTP.
export class HttpProgramResolver implements ProgramResolver {
  #httpRoot: string;
  #mainUrl: URL;
  #main?: Promise<Source>;
  constructor(main: string | URL) {
    this.#mainUrl = !(main instanceof URL) ? new URL(main) : main;
    this.#httpRoot = dirname(this.#mainUrl.pathname);
  }

  main(): Promise<Source> {
    if (!this.#main) {
      this.#main = this.#fetch(this.#mainUrl);
    }
    return this.#main;
  }

  resolveSource(specifier: string): Promise<Source | undefined> {
    if (!specifier || specifier[0] !== "/") {
      return Promise.resolve(undefined);
    }
    const url = new URL(this.#mainUrl);
    url.pathname = join(
      this.#httpRoot,
      specifier.substring(1, specifier.length),
    );
    return this.#fetch(url);
  }

  async #fetch(url: URL): Promise<Source> {
    const res = await fetch(url);
    const contents = await res.text();
    return {
      name: url.pathname.substring(this.#httpRoot.length),
      contents,
    };
  }
}
