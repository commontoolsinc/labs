import { env } from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { Identity } from "@commonfabric/identity";
import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";

const { FRONTEND_URL } = env;

describe("shell worker runtime", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  it("loads the worker runtime bundle in the browser", async () => {
    const page = shell.page();
    await page.goto(FRONTEND_URL);
    await page.applyConsoleFormatter();

    const probe = await page.evaluate(async () => {
      return await new Promise((resolve) => {
        const worker = new Worker("/scripts/worker-runtime.js", {
          type: "module",
          name: "probe-worker",
        });
        const timeout = setTimeout(() => {
          worker.terminate();
          resolve({ type: "timeout" });
        }, 5000);
        worker.addEventListener("message", (event) => {
          clearTimeout(timeout);
          worker.terminate();
          resolve({ type: "message", data: event.data });
        }, { once: true });
        worker.addEventListener("error", (event) => {
          clearTimeout(timeout);
          worker.terminate();
          resolve({
            type: "error",
            message: event.message,
            filename: event.filename,
            lineno: event.lineno,
            colno: event.colno,
          });
        }, { once: true });
      });
    });

    if ((probe as { type: string }).type !== "message") {
      throw new Error(
        `Expected worker READY message, got ${JSON.stringify(probe)}`,
      );
    }

    const message = probe as { type: "message"; data: unknown };
    if (message.data !== "READY") {
      throw new Error(`Expected READY, got ${JSON.stringify(message.data)}`);
    }
  });

  it("starts the default worker through RootView and RuntimeInternals", async () => {
    const page = shell.page();
    await page.goto(FRONTEND_URL);
    await page.applyConsoleFormatter();

    const identity = await Identity.generate({ implementation: "noble" });
    await shell.login(identity);

    const runtimeIdentity = await page.evaluate(() => ({
      hasRuntime: !!globalThis.commonfabric?.rt,
      identityDid: globalThis.app.state().identity?.did(),
    }));
    assertEquals(runtimeIdentity, {
      hasRuntime: true,
      identityDid: identity.did(),
    });
  });
});
