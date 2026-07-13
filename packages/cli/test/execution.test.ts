import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { cf, checkStderr, stripAnsi } from "./utils.ts";
import { createSession, Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { StandaloneMemoryServer } from "@commonfabric/memory/v2/standalone";
import { join } from "@std/path";
import {
  getSpaceExecutionPolicy,
  readExecutionPolicy,
  setSpaceExecutionPolicy,
  writeExecutionPolicy,
} from "../lib/execution.ts";

async function withIdentityFile<T>(
  identity: Identity,
  fn: (identityPath: string) => Promise<T>,
): Promise<T> {
  const directory = await Deno.makeTempDir({
    prefix: "cf-execution-policy-test-",
  });
  const identityPath = join(directory, "identity.pk8");
  try {
    await Deno.writeFile(identityPath, identity.toPkcs8());
    return await fn(identityPath);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}

async function readCanonicalPolicy(
  apiUrl: URL,
  identity: Identity,
  space: MemorySpace,
): Promise<unknown> {
  const storage = StorageManager.open({ as: identity, memoryHost: apiUrl });
  const runtime = new Runtime({ apiUrl, storageManager: storage });
  try {
    const cell = runtime.getCellFromEntityId(
      space,
      `of:${space}:execution-policy`,
    );
    await cell.sync();
    return cell.get();
  } finally {
    await runtime.dispose();
    await storage.close();
  }
}

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
    const runtime = {
      getCellFromEntityId: () => ({
        sync: () => Promise.resolve(),
        get: () => null,
      }),
    } as unknown as Runtime;
    expect(
      await readExecutionPolicy(
        runtime,
        "did:key:z6Mk-cli-malformed-execution-policy",
      ),
    ).toBe("absent");
  });

  it("treats a policy with extra fields as absent", async () => {
    const runtime = {
      getCellFromEntityId: () => ({
        sync: () => Promise.resolve(),
        get: () => ({
          version: 1,
          serverPrimaryExecution: true,
          ignoredByServer: true,
        }),
      }),
    } as unknown as Runtime;
    expect(
      await readExecutionPolicy(
        runtime,
        "did:key:z6Mk-cli-extra-field-execution-policy",
      ),
    ).toBe("absent");
  });

  it("uses the derived named-space identity for policy authority in ACL-off mode", async () => {
    const user = await Identity.fromPassphrase(
      "cli named-space execution policy user",
      { implementation: "noble" },
    );
    const server = StandaloneMemoryServer.start({
      acl: { mode: "off" },
    });
    try {
      await withIdentityFile(user, async (identityPath) => {
        const session = await createSession({
          identity: user,
          spaceName: "cli-execution-policy-named-space",
        });
        const config = {
          apiUrl: server.url,
          identityPath,
          space: "cli-execution-policy-named-space",
        };
        await setSpaceExecutionPolicy(config, true);
        expect(
          await readCanonicalPolicy(server.url, user, session.space),
        ).toEqual({ version: 1, serverPrimaryExecution: true });
        expect(await getSpaceExecutionPolicy(config)).toBe("enabled");
      });
    } finally {
      await server.close();
    }
  });

  it("preserves the supplied identity as policy authority for raw DID spaces", async () => {
    const operator = await Identity.fromPassphrase(
      "cli raw did execution policy operator",
      { implementation: "noble" },
    );
    const space = await Identity.fromPassphrase(
      "cli raw did execution policy space",
      { implementation: "noble" },
    );
    const server = StandaloneMemoryServer.start({
      acl: { mode: "off", serviceDids: [operator.did()] },
    });
    try {
      await withIdentityFile(operator, async (identityPath) => {
        const config = {
          apiUrl: server.url,
          identityPath,
          space: space.did(),
        };
        await setSpaceExecutionPolicy(config, true);
        expect(
          await readCanonicalPolicy(server.url, operator, space.did()),
        ).toEqual({ version: 1, serverPrimaryExecution: true });
        expect(await getSpaceExecutionPolicy(config)).toBe("enabled");
      });
    } finally {
      await server.close();
    }
  });
});
