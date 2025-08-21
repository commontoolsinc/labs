import { ConsoleEvent } from "@astral/astral";
import { Manifest } from "./manifest.ts";
import { summarize } from "./utils.ts";
import { BrowserController } from "./browser.ts";
import { Reporter } from "./reporter.ts";
import { TestFileResults, TestResultError } from "./interface.ts";

export class Runner {
  manifest: Manifest;
  reporter: Reporter;
  browser: BrowserController;
  results: TestFileResults[];

  constructor(manifest: Manifest, serverPort: number) {
    this.manifest = manifest;
    this.reporter = new Reporter();
    this.results = [];
    this.browser = new BrowserController(manifest, serverPort);
    this.browser.addEventListener(
      "console",
      (e: Event) => this.onConsole(e as ConsoleEvent),
    );
  }

  // Runs all tests in the browser. Return value
  // indicates whether all tests have passed successfully or not.
  async run(): Promise<boolean> {
    this.reporter.onRunStart();

    for (const tsTestPath of this.manifest.tests) {
      const results: TestFileResults = {
        fileName: tsTestPath,
        tests: [],
      };
      this.results.push(results);

      try {
        await this.browser.load(tsTestPath);
      } catch (e: unknown) {
        this.reporter.onLoadError(tsTestPath, e as TestResultError);
        await this.browser.close();
        return false;
      }

      const testCount = await this.browser.getTestCount();
      this.reporter.onFileStart(tsTestPath, testCount);

      // Run tests while there's work to do
      while (true) {
        const testResult = await this.browser.runNextTest();
        if (!testResult) {
          break;
        }
        results.tests.push(testResult);
        this.reporter.onTestCompleted(testResult);
      }
      this.reporter.onFileEnd(tsTestPath);
    }

    const summary = summarize(this.results);
    this.reporter.onRunEnd(summary);
    await this.browser.close();
    return summary.failed.length === 0;
  }

  onConsole(e: ConsoleEvent) {
    if (this.manifest.config.pipeConsole) {
      switch (e.detail.type) {
        case "warning":
          console.warn(`browser: ${e.detail.text}`);
          break;
        case "log":
        case "info":
        case "debug":
        case "error":
          console[e.detail.type](`browser: ${e.detail.text}`);
          break;
      }
    }
  }
}
