import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { getPatternEnvironment, setPatternEnvironment } from "../src/env.ts";
import type { PatternEnvironment } from "@commonfabric/api";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("bash tool request body");
const space = signer.did();

// Read the shipped pattern source so this test exercises the real `bash`
// pattern through the transformer, not a copy. `common-fabric.tsx`'s only
// non-builtin import is `./backlinks-index.tsx`, so the two files plus a small
// default-export shim form a self-contained program.
const systemDir = new URL("../../patterns/system/", import.meta.url);
const commonFabricSource = await Deno.readTextFile(
  new URL("common-fabric.tsx", systemDir),
);
const backlinksIndexSource = await Deno.readTextFile(
  new URL("backlinks-index.tsx", systemDir),
);

const bashProgram: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        'import { bash } from "./common-fabric.tsx";',
        "export default bash;",
      ].join("\n"),
    },
    { name: "/common-fabric.tsx", contents: commonFabricSource },
    { name: "/backlinks-index.tsx", contents: backlinksIndexSource },
  ],
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The bash pattern fires `fetchData` to /api/sandbox/exec through the
// post-commit outbox, so the captured request body lands a tick after the
// commit. Pull and wait until the exec call shows up.
async function captureExecRequestBody(
  fetchCalls: Array<{ url: string; init?: RequestInit }>,
  result: { pull(): Promise<unknown> },
): Promise<{ url: string; rawBody: string | undefined }> {
  for (let attempt = 0; attempt < 20; attempt++) {
    await result.pull();
    await delay(50);
    const call = fetchCalls.find((c) => c.url.includes("/api/sandbox/exec"));
    if (call) {
      return { url: call.url, rawBody: call.init?.body as string | undefined };
    }
  }
  throw new Error("fetchData never called /api/sandbox/exec");
}

describe("bash pattern request body", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;
  let originalFetch: typeof globalThis.fetch;
  let originalPatternEnvironment: PatternEnvironment;
  let fetchCalls: Array<{ url: string; init?: RequestInit }>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();

    originalPatternEnvironment = getPatternEnvironment();
    setPatternEnvironment({
      apiUrl: new URL("http://mock-test-server.local"),
    });

    fetchCalls = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;
      fetchCalls.push({ url, init });
      return Promise.resolve(
        new Response(
          JSON.stringify({ stdout: "", stderr: "", exitCode: 0 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    };
  });

  afterEach(async () => {
    await tx.commit();
    globalThis.fetch = originalFetch;
    setPatternEnvironment(originalPatternEnvironment);
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("sends a non-empty body with sandboxId and command for a command-only call", async () => {
    const compiled = await runtime.patternManager.compilePattern(bashProgram);
    const resultCell = runtime.getCell(
      space,
      "bash-command-only",
      undefined,
      tx,
    );
    // The common case: the model supplies only `command`, the framework
    // provides `sandboxId`, and the three optional fields are absent.
    const result = runtime.run(
      tx,
      compiled,
      { command: "echo hello", sandboxId: "sandbox-abc" },
      resultCell,
    );
    await tx.commit();
    tx = runtime.edit();

    const { rawBody } = await captureExecRequestBody(fetchCalls, result);

    // A non-empty body (the bug sent Content-Length: 0).
    expect(typeof rawBody).toBe("string");
    expect(rawBody!.length).toBeGreaterThan(0);

    const body = JSON.parse(rawBody!);
    expect(body.command).toBe("echo hello");
    expect(body.sandboxId).toBe("sandbox-abc");
    // Absent optionals stay out of the body (no `undefined` keys).
    expect("workingDirectory" in body).toBe(false);
    expect("timeout" in body).toBe(false);
    expect("environment" in body).toBe(false);
  });

  it("includes the optional fields in the body when they are supplied", async () => {
    const compiled = await runtime.patternManager.compilePattern(bashProgram);
    const resultCell = runtime.getCell(
      space,
      "bash-with-optionals",
      undefined,
      tx,
    );
    const result = runtime.run(
      tx,
      compiled,
      {
        command: "ls",
        sandboxId: "sandbox-xyz",
        workingDirectory: "/tmp",
        timeout: 5000,
        environment: { FOO: "bar" },
      },
      resultCell,
    );
    await tx.commit();
    tx = runtime.edit();

    const { rawBody } = await captureExecRequestBody(fetchCalls, result);

    const body = JSON.parse(rawBody!);
    expect(body.command).toBe("ls");
    expect(body.sandboxId).toBe("sandbox-xyz");
    expect(body.workingDirectory).toBe("/tmp");
    expect(body.timeout).toBe(5000);
    expect(body.environment).toEqual({ FOO: "bar" });
  });
});
