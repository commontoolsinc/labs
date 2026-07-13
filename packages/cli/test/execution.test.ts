import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { cf, checkStderr, stripAnsi } from "./utils.ts";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { readExecutionPolicy, writeExecutionPolicy } from "../lib/execution.ts";

describe("cli execution policy", () => {
  it("exposes owner-scoped enable, disable, and status commands", async () => {
    const { code, stdout, stderr } = await cf("execution --help");
    checkStderr(stderr);
    const output = stripAnsi(stdout.join("\n"));
    expect(output).toContain("enable");
    expect(output).toContain("disable");
    expect(output).toContain("status");
    expect(output).toContain("--space");
    expect(output).toContain("<space>");
    expect(code).toBe(0);
  });

  it("writes and reads the canonical whole-document policy", async () => {
    const signer = await Identity.fromPassphrase(
      "cli execution policy test principal",
    );
    const storage = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    try {
      expect(await readExecutionPolicy(runtime, signer.did())).toBe("absent");
      await writeExecutionPolicy(runtime, signer.did(), true);
      expect(await readExecutionPolicy(runtime, signer.did())).toBe("enabled");
      await writeExecutionPolicy(runtime, signer.did(), false);
      expect(await readExecutionPolicy(runtime, signer.did())).toBe("disabled");
    } finally {
      await runtime.dispose();
      await storage.close();
    }
  });

  it("treats a malformed null policy as absent", async () => {
    const signer = await Identity.fromPassphrase(
      "cli malformed execution policy test principal",
    );
    const storage = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    try {
      const tx = runtime.edit();
      runtime.getCell<unknown>(
        signer.did(),
        `of:${signer.did()}:execution-policy`,
        undefined,
        tx,
      ).set(null);
      const result = await tx.commit();
      expect(result.error).toBeUndefined();

      expect(await readExecutionPolicy(runtime, signer.did())).toBe("absent");
    } finally {
      await runtime.dispose();
      await storage.close();
    }
  });
});
