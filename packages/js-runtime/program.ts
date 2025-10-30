import { isDeno } from "@commontools/utils/env";
import { ProgramResolver, Source } from "./interface.ts";
import { dirname, join } from "@std/path/posix";

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
// Supports both absolute path-based specifiers (starting with "/")
// and full URL specifiers (starting with "http://" or "https://")
export class HttpProgramResolver implements ProgramResolver {
  #httpRoot: string;
  #mainUrl: URL;
  #main?: Promise<Source>;
  #cache = new Map<string, Promise<Source>>();

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
    // Handle full URL specifiers (from URL-based relative import resolution)
    if (specifier.startsWith("http://") || specifier.startsWith("https://")) {
      // Check cache first (cache by canonical URL without query string)
      const canonicalUrl = this.#stripQueryString(specifier);
      if (this.#cache.has(canonicalUrl)) {
        return this.#cache.get(canonicalUrl) as Promise<Source>;
      }

      const fetchPromise = this.#fetch(new URL(specifier));
      this.#cache.set(canonicalUrl, fetchPromise);
      return fetchPromise;
    }

    // Handle absolute path specifiers (original behavior)
    if (specifier && specifier[0] === "/") {
      const url = new URL(this.#mainUrl);
      url.pathname = join(
        this.#httpRoot,
        specifier.substring(1, specifier.length),
      );

      const canonicalUrl = this.#stripQueryString(url.href);
      if (this.#cache.has(canonicalUrl)) {
        return this.#cache.get(canonicalUrl) as Promise<Source>;
      }

      const fetchPromise = this.#fetch(url);
      this.#cache.set(canonicalUrl, fetchPromise);
      return fetchPromise;
    }

    return Promise.resolve(undefined);
  }

  async #fetch(url: URL): Promise<Source> {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(
        `Failed to fetch ${url.href}: ${res.status} ${res.statusText}`,
      );
    }
    const contents = await res.text();

    // Use URL without query string as the file name so TypeScript recognizes the extension
    // But fetch using the full URL (with query string for cache busting)
    const canonicalName = this.#stripQueryString(url.href);

    return {
      name: canonicalName,
      contents,
    };
  }

  // Strip query string and hash from URL for use as file identifier
  #stripQueryString(url: string): string {
    const questionIndex = url.indexOf("?");
    const hashIndex = url.indexOf("#");

    if (questionIndex === -1 && hashIndex === -1) {
      return url;
    }

    if (questionIndex !== -1 && hashIndex !== -1) {
      return url.substring(0, Math.min(questionIndex, hashIndex));
    }

    if (questionIndex !== -1) {
      return url.substring(0, questionIndex);
    }

    return url.substring(0, hashIndex);
  }
}
