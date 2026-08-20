import {
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  SEPARATOR,
} from "@std/path";

import { isDeno } from "@commonfabric/utils/env";

import { ProgramResolver, Source } from "./interface.ts";

/**
 * Guard the Deno-only file system entry points. Each caller names itself, so a
 * caller reaching this in a browser or worker is told which one it was.
 */
function requireDeno(what: string): void {
  if (!isDeno()) {
    throw new Error(`${what} is not supported in this environment.`);
  }
}

function isOutsideRoot(relativePath: string): boolean {
  return relativePath === ".." || relativePath.startsWith(`..${SEPARATOR}`) ||
    isAbsolute(relativePath);
}

function groundedSourceName(relativePath: string): string {
  const portablePath = SEPARATOR === "/"
    ? relativePath
    : relativePath.replaceAll(SEPARATOR, "/");
  return `/${portablePath}`;
}

export class InMemoryProgram implements ProgramResolver {
  private modules: Record<string, string>;
  private _main: string;
  constructor(main: string, modules: Record<string, string>) {
    this.modules = modules;
    this._main = main;
  }

  main(): Promise<Source> {
    const main = this.modules[this._main];
    if (main === undefined) {
      throw new Error(`${this._main} not in modules.`);
    }
    return Promise.resolve({ name: this._main, contents: main });
  }

  resolveSource(identifier: string): Promise<Source | undefined> {
    const contents = this.modules[identifier];
    if (contents === undefined) return Promise.resolve(undefined);
    return Promise.resolve({ contents, name: identifier });
  }
}

/**
 * Read a data file from the file system as a program source, grounded against
 * `rootPath` exactly as {@link FileSystemProgramResolver} grounds a module: the
 * returned `name` is the portable, root-relative path the deployed package
 * stores it under, and a path that escapes the root — through `..` or through a
 * symbolic link — is refused.
 *
 * A source package holds text, so the bytes are decoded as UTF-8 strictly. A
 * file that is not valid UTF-8 is reported by name rather than being silently
 * stored with replacement characters in place of the bytes that were read.
 *
 * Deno-only.
 */
export function readDataFileSource(
  dataPath: string,
  rootPath: string,
): Source {
  requireDeno("readDataFileSource");
  const fsRoot = normalize(rootPath);
  const normalizedDataPath = normalize(dataPath);
  const relativeDataPath = relative(fsRoot, normalizedDataPath);
  if (isOutsideRoot(relativeDataPath)) {
    throw new Error(
      `Data file "${dataPath}" must be within root directory "${fsRoot}".`,
    );
  }
  const realDataPath = Deno.realPathSync(normalizedDataPath);
  if (isOutsideRoot(relative(Deno.realPathSync(fsRoot), realDataPath))) {
    throw new Error(
      `Data file "${dataPath}" must be within root directory "${fsRoot}".`,
    );
  }
  return {
    name: groundedSourceName(relativeDataPath),
    contents: decodeDataFile(Deno.readFileSync(realDataPath), dataPath),
  };
}

/**
 * Decode a data file's bytes as the text a source package stores.
 *
 * A source package holds text, so the bytes are decoded as UTF-8 strictly: a
 * file that is not valid UTF-8 is reported by `name` rather than stored with
 * replacement characters in place of the bytes that were read. `ignoreBOM`
 * keeps a leading byte order mark in the result instead of consuming it, since
 * a data file is stored byte for byte and dropping the mark would deploy
 * something other than the authored file.
 */
export function decodeDataFile(bytes: Uint8Array, name: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
      .decode(bytes);
  } catch {
    throw new Error(`Data file "${name}" is not valid UTF-8 text.`);
  }
}

// Resolve a program using the file system.
// Deno-only.
export class FileSystemProgramResolver implements ProgramResolver {
  private fsRoot: string;
  private realFsRoot: string;
  private _main: Source;
  constructor(mainPath: string, rootPath?: string) {
    this.fsRoot = normalize(rootPath ?? dirname(mainPath));
    const normalizedMainPath = normalize(mainPath);
    const relativeMainPath = relative(this.fsRoot, normalizedMainPath);
    if (rootPath && isOutsideRoot(relativeMainPath)) {
      throw new Error(
        `Main file "${mainPath}" must be within root directory "${this.fsRoot}".`,
      );
    }
    this.realFsRoot = this.#realPath(this.fsRoot);
    const realMainPath = this.#realPath(normalizedMainPath);
    if (isOutsideRoot(relative(this.realFsRoot, realMainPath))) {
      throw new Error(
        `Main file "${mainPath}" must be within root directory "${this.fsRoot}".`,
      );
    }
    this._main = {
      name: groundedSourceName(relativeMainPath),
      contents: this.#readFile(realMainPath),
    };
  }

  main(): Promise<Source> {
    return Promise.resolve(this._main);
  }

  resolveSource(specifier: string): Promise<Source | undefined> {
    if (!specifier || specifier[0] !== "/") {
      return Promise.resolve(undefined);
    }
    const absPath = normalize(
      join(
        this.fsRoot,
        specifier.substring(1, specifier.length).replaceAll("/", SEPARATOR),
      ),
    );
    if (isOutsideRoot(relative(this.fsRoot, absPath))) {
      throw new Error(
        `Import "${specifier}" resolves outside of root directory "${this.fsRoot}".`,
      );
    }
    const realPath = this.#realPath(absPath);
    if (isOutsideRoot(relative(this.realFsRoot, realPath))) {
      throw new Error(
        `Import "${specifier}" resolves outside of root directory "${this.fsRoot}".`,
      );
    }
    return Promise.resolve({
      name: specifier,
      contents: this.#readFile(realPath),
    });
  }

  resolveDataFile(name: string): Promise<Source | undefined> {
    requireDeno("FileSystemProgramResolver");
    const path = this.#groundedPath(name);
    if (path === undefined) return Promise.resolve(undefined);
    let bytes: Uint8Array;
    try {
      bytes = Deno.readFileSync(path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return Promise.resolve(undefined);
      }
      throw error;
    }
    return Promise.resolve({ name, contents: decodeDataFile(bytes, name) });
  }

  #groundedPath(specifier: string): string | undefined {
    if (!specifier || specifier[0] !== "/") return undefined;
    const absPath = normalize(
      join(
        this.fsRoot,
        specifier.substring(1, specifier.length).replaceAll("/", SEPARATOR),
      ),
    );
    if (isOutsideRoot(relative(this.fsRoot, absPath))) {
      throw new Error(
        `Import "${specifier}" resolves outside of root directory "${this.fsRoot}".`,
      );
    }
    return absPath;
  }

  #realPath(path: string): string {
    requireDeno("FileSystemProgramResolver");
    return Deno.realPathSync(path);
  }

  #readFile(path: string): string {
    requireDeno("FileSystemProgramResolver");
    return Deno.readTextFileSync(path);
  }
}

// Resolve a program from HTTP.
export class HttpProgramResolver implements ProgramResolver {
  #mainUrl: URL;
  #main?: Promise<Source>;
  #fetchImpl: typeof globalThis.fetch;
  constructor(
    main: string | URL,
    fetchImpl?: typeof globalThis.fetch,
  ) {
    this.#mainUrl = !(main instanceof URL) ? new URL(main) : main;
    // Keep the host receiver for browser fetch. Capturing a fetch function and
    // later calling it as a resolver field makes WorkerGlobalScope reject the
    // call with `Illegal invocation`.
    this.#fetchImpl = fetchImpl
      ? (input, init) => fetchImpl.call(globalThis, input, init)
      : (input, init) => globalThis.fetch(input, init);
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
    url.pathname = normalize(specifier);
    return this.#fetch(url);
  }

  async resolveDataFile(name: string): Promise<Source | undefined> {
    if (!name || name[0] !== "/") return undefined;
    const url = new URL(this.#mainUrl);
    url.pathname = normalize(name);
    const res = await this.#fetchImpl(url);
    if (!res.ok) return undefined;
    return {
      name,
      contents: decodeDataFile(new Uint8Array(await res.arrayBuffer()), name),
    };
  }

  async #fetch(url: URL): Promise<Source> {
    const res = await this.#fetchImpl(url);
    if (!res.ok) {
      throw new Error(
        `Failed to fetch ${url}: ${res.status} ${res.statusText}`,
      );
    }
    const contents = await res.text();
    return {
      name: url.pathname,
      contents,
    };
  }
}
