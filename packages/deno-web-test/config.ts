import { LaunchOptions } from "@astral/astral";
import * as path from "@std/path";
import { exists } from "@std/fs/exists";

// These configurations can be applied
// by placing a `deno-web-test.config.ts` in package root.
export type Config = {
  // Whether the test runner should run headlessly. Default: true.
  headless?: boolean;
  // What browser to run.
  product?: "chrome" | "firefox";
  // Arguments to be passed into the browser.
  args?: string[];
  // Whether or not console commands should be propagated to the deno-web-test process.
  pipeConsole?: boolean;
};

export const applyDefaults = (config: object): Config => {
  return Object.assign({
    headless: true,
    devtools: false,
    pipeConsole: true,
  }, config);
};

export const extractAstralConfig = (config: Config): LaunchOptions => {
  const astralConfig: LaunchOptions = {};
  if ("headless" in config) astralConfig.headless = config.headless;
  if ("product" in config) astralConfig.product = config.product;
  if ("args" in config) astralConfig.args = config.args;
  return astralConfig;
};

export const getConfig = async (projectDir: string): Promise<Config> => {
  const configPath = path.join(projectDir, "deno-web-test.config.ts");

  if (await exists(configPath, { isFile: true })) {
    // Try to evaluate it
    try {
      const config = (await import(configPath)).default;
      return applyDefaults(config);
    } catch (e) {
      console.error(`Unable to execute deno-web-test.config.ts`);
    }
  }
  return applyDefaults({});
};
