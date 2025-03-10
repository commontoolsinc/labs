// These are @astral/astral configurations.
export type AstralConfig = {
  headless?: boolean;
  devtools?: boolean;
  product?: "chrome" | "firefox";
  args?: string[];
};

// These configurations can be applied
// by placing a `deno-web-test.config.ts` in package root.
export type Config = {
  astral?: AstralConfig;
};

export type TestResultError = {
  message: string;
  name: string;
  stack?: string;
};

export type TestResult = {
  name: string;
  error: TestResultError | null;
  duration: number;
};

export type TestFileResults = {
  fileName: string;
  tests: TestResult[];
};

export type Summary = {
  passed: number;
  duration: number;
  failed: TestResult[];
};
