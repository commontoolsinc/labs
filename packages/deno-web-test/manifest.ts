import * as path from "@std/path";

import { Config, getConfig } from "./config.ts";

export class Manifest {
  readonly #projectDir: string;
  readonly #tests: string[];
  readonly #runDir: string;
  readonly #config: Config;

  constructor(
    projectDir: string,
    tests: string[],
    runDir: string,
    config: Config,
  ) {
    this.#projectDir = projectDir;
    this.#tests = tests;
    this.#runDir = runDir;
    this.#config = config;
  }

  // The root directory path of the project being tested.
  get projectDir(): string {
    return this.#projectDir;
  }

  // An array of relative paths to tests
  // from `projectDir`.
  get tests(): string[] {
    return this.#tests;
  }

  // The root directory path of the static server.
  get serverDir(): string {
    return path.join(this.#runDir, "server");
  }

  // The directory the browser keeps its profile in.
  get profileDir(): string {
    return path.join(this.#runDir, "profile");
  }

  // The requested port the static server is being served on.
  // If `0` (the default), the actual listening port will be different.
  get requestedPort(): number {
    return 0;
  }

  // Configuration defined via `deno-web-test.config.ts`
  get config(): Config {
    return this.#config;
  }

  // Removes everything the run wrote, both directories above included. The
  // rename goes first: removing a tree walks it and then removes the root,
  // and a process writing by the path the run handed it would put an entry
  // back into a directory the walk had already been through. Under the new
  // name it writes to a path that no longer resolves, and the walk sees a
  // tree nothing can add to.
  async remove(): Promise<void> {
    const removing = `${this.#runDir}.removing`;
    await Deno.rename(this.#runDir, removing);
    await Deno.remove(removing, { recursive: true });
  }

  static async create(projectDir: string, tests: string[]): Promise<Manifest> {
    const config = await getConfig(projectDir);
    const manifest = new Manifest(
      projectDir,
      tests,
      await Deno.makeTempDir({ prefix: "deno-web-test-" }),
      config,
    );
    await Deno.mkdir(manifest.serverDir);
    await Deno.mkdir(manifest.profileDir);
    return manifest;
  }
}
