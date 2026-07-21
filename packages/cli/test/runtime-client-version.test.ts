import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { createRuntime as createAclRuntime } from "../lib/acl.ts";
import { loadManager } from "../lib/piece.ts";
import { withEnv } from "./utils.ts";

const TEST_COMMIT_SHA = "cli-runtime-version-test-sha";

describe("CLI runtime client version", () => {
  it("passes COMMIT_SHA through the ACL runtime", async () => {
    const identity = await Identity.fromPassphrase("acl runtime version test");
    const session = await createSession({
      identity,
      spaceName: "acl-runtime-version",
    });
    const originalHealthCheck = Runtime.prototype.healthCheck;
    let created: Runtime | undefined;
    Runtime.prototype.healthCheck = function () {
      created = this;
      return Promise.resolve(false);
    };

    await withEnv("COMMIT_SHA", TEST_COMMIT_SHA, async () => {
      try {
        await expect(createAclRuntime({
          apiUrl: new URL("https://toolshed.test"),
          identityPath: "unused",
          space: "unused",
        }, session)).rejects.toThrow("Could not connect");
        expect(created).toBeDefined();
        expect(created!.clientVersion).toBe(TEST_COMMIT_SHA);
      } finally {
        Runtime.prototype.healthCheck = originalHealthCheck;
        if (created) {
          await (created.storageManager as unknown as {
            closeNow(): Promise<void>;
          }).closeNow();
          await created.dispose();
        }
      }
    });
  });

  it("passes COMMIT_SHA through the piece manager runtime", async () => {
    const identity = await Identity.fromPassphrase(
      "piece runtime version test",
      { implementation: "noble" },
    );
    const keyPath = await Deno.makeTempFile();
    await Deno.writeFile(keyPath, identity.toPkcs8());
    const originalHealthCheck = Runtime.prototype.healthCheck;
    let created: Runtime | undefined;
    Runtime.prototype.healthCheck = function () {
      created = this;
      return Promise.resolve(false);
    };

    await withEnv("COMMIT_SHA", TEST_COMMIT_SHA, async () => {
      try {
        await expect(loadManager({
          apiUrl: "https://toolshed.test",
          identity: keyPath,
          space: "piece-runtime-version",
        })).rejects.toThrow("Could not connect");
        expect(created).toBeDefined();
        expect(created!.clientVersion).toBe(TEST_COMMIT_SHA);
      } finally {
        Runtime.prototype.healthCheck = originalHealthCheck;
        await Deno.remove(keyPath);
      }
    });
  });
});
