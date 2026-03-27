import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { FileSystemProgramResolver } from "@commontools/js-compiler";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import type { Module } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import {
  deriveImplementationIdentity,
  encodeImplementationIdentity,
  encodeImplementationOrigin,
  implementationIdentityOrigin,
} from "../src/cfc/implementation-identity.ts";

const signer = await Identity.fromPassphrase("cfc example code origin");

describe("CFC code origin from authored patterns", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      storageManager,
      apiUrl: new URL(import.meta.url),
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  it("derives code hash identity and source origin from a real pattern file via the runtime harness", async () => {
    const sourcePath = join(
      import.meta.dirname!,
      "..",
      "..",
      "patterns",
      "examples",
      "cfc-ui-direct-command.tsx",
    );
    const rootPath = join(import.meta.dirname!, "..", "..", "patterns");
    const programSource = await runtime.harness.resolve(
      new FileSystemProgramResolver(sourcePath, rootPath),
    );
    const { id, jsScript } = await runtime.harness.compile(programSource);
    const evaluated = await runtime.harness.evaluate(
      id,
      jsScript,
      programSource.files,
    );
    const pattern = evaluated.main?.default as
      | { nodes?: Array<{ module: Module }> }
      | undefined;

    const handlerNode = pattern?.nodes?.find((node) =>
      node.module.wrapper === "handler"
    );
    expect(handlerNode).toBeDefined();

    const identity = deriveImplementationIdentity(handlerNode!.module);
    const origin = implementationIdentityOrigin(identity);
    const originDisplay = origin?.sourceLocation ?? origin?.bundleLocation;

    expect(identity.kind).toBe("codeHash");
    expect(encodeImplementationIdentity(identity)).toContain("CodeHash(");
    expect(originDisplay).toMatch(
      /(?:cfc-ui-direct-command\.tsx:\d+:\d+|[a-z0-9]{16,}\.js, <anonymous>:\d+:\d+)$/,
    );
    expect(encodeImplementationOrigin(identity)).toMatch(
      /CodeHash\(.+\) @ .+(?:cfc-ui-direct-command\.tsx:\d+:\d+|[a-z0-9]{16,}\.js, <anonymous>:\d+:\d+)$/,
    );
  });
});
