import * as path from "@std/path";
import { Config, getConfig } from "./config.ts";
import { exists } from "@std/fs/exists";

export class Manifest {
  // The root directory path of the project being tested.
  readonly projectDir: string;
  // An array of relative paths to tests
  // from `projectDir`.
  readonly tests: string[];
  // The root directory path of the static server.
  readonly serverDir: string;
  // The port the static server is being served on.
  readonly port: number;
  // Configuration defined via `deno-web-test.config.ts`
  readonly config: Config;

  constructor(
    projectDir: string,
    tests: string[],
    serverDir: string,
    config: Config,
  ) {
    this.projectDir = projectDir;
    this.tests = tests;
    this.serverDir = serverDir;
    this.port = 8000;
    this.config = config;
  }

  static async create(projectDir: string, tests: string[]): Promise<Manifest> {
    const serverDir = await Deno.makeTempDir();
    const config = await getConfig(projectDir);
    return new Manifest(projectDir, tests, serverDir, config);
  }
}
