import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import type { Module, Pattern } from "../src/builder/types.ts";
import { resolvePolicyFacingImplementationIdentity } from "../src/cfc/implementation-identity.ts";

// Regression: under the ESM module-record loader, a verified handler's
// `implementation.src` must resolve back to its ORIGINAL authored source
// (`/main.tsx:line:col`), not the raw concatenated-bundle coordinate
// (`<loadId>.js:line:col`). Otherwise CFC verified-source identity fails closed
// (`isVerifiedSourceInLoad` === false → kind "unsupported"), which breaks every
// CFC trusted action. The fix composes a per-load bundle source map
// (see composeBundleSourceMap) and registers it so `mapPosition` can translate
// the coordinate.

const signer = await Identity.fromPassphrase("test operator");

const program: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        "import { Cell, Default, handler, pattern } from 'commonfabric';",
        "const inc = handler<unknown, { count: Cell<number> }>(",
        "  (_event, { count }) => { count.set(count.get() + 1); },",
        ");",
        "export default pattern<{ count: number | Default<0> }>(({ count }) => {",
        "  return { count, inc: inc({ count }) };",
        "});",
      ].join("\n"),
    },
  ],
};

interface HandlerIdentityProbe {
  src: string | undefined;
  verifiedLoadId: string | undefined;
  isVerifiedSourceInLoad: boolean | undefined;
  kind: string | undefined;
  /**
   * The scheduler's content-addressed implementation hash for this handler,
   * derived from `fn.src` via `harness.implementationHashForSource`. This is the
   * SECOND consumer of ESM source-location fidelity (the first is CFC
   * verified-source above): the scheduler keys reload-stable action identity on
   * it, so it must resolve under the ESM loader.
   */
  implHash: string | undefined;
}

function probeHandlerIdentity(
  runtime: Runtime,
  compiled: Pattern,
): HandlerIdentityProbe {
  const nodes = (compiled as Pattern & { nodes: { module: Module }[] }).nodes;
  const handlerModule = nodes
    .map((n) => n.module)
    .find((m) =>
      m && m.type === "javascript" && m.wrapper === "handler" &&
      typeof m.implementationRef === "string"
    );
  if (!handlerModule) {
    throw new Error("no verified handler node found in compiled pattern");
  }
  const implementationRef = handlerModule.implementationRef!;
  const verifiedLoadId = runtime.harness.getVerifiedLoadId?.(implementationRef);
  const fn = runtime.harness.getExecutableFunction?.(
    implementationRef,
  ) as (((...a: unknown[]) => unknown) & { src?: string }) | undefined;
  const src = fn?.src;
  const match = typeof src === "string" ? /^(.*):(\d+):(\d+)$/.exec(src) : null;
  const rawPath = match ? match[1] : undefined;
  const normalizedPath = rawPath
    ? (rawPath.startsWith("/") ? rawPath : `/${rawPath}`)
    : undefined;
  const isVerifiedSourceInLoad = (verifiedLoadId && normalizedPath)
    ? runtime.harness.isVerifiedSourceInLoad?.(verifiedLoadId, normalizedPath)
    : undefined;
  const identity = resolvePolicyFacingImplementationIdentity(handlerModule, {
    verifiedLoadId,
    harness: runtime.harness,
    implementation: fn as never,
  });
  const implHash = typeof src === "string"
    ? runtime.harness.implementationHashForSource?.(src)
    : undefined;
  return {
    src,
    verifiedLoadId,
    isVerifiedSourceInLoad,
    kind: identity?.kind,
    implHash,
  };
}

describe("ESM loader: verified-source location resolution", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  const makeRuntime = () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  };

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("resolves a handler's src to its original source under the ESM loader", async () => {
    makeRuntime();
    const compiled = await runtime.patternManager.compilePattern(program);
    const r = probeHandlerIdentity(runtime, compiled);

    // src maps back to the authored file, not a `<loadId>.js` / `:esm:` bundle.
    expect(r.src).toMatch(/(?:^|\/)main\.tsx:\d+:\d+$/);
    expect(r.src).not.toMatch(/:esm:|\.js:\d+:\d+$/);
    // src is the reload-stable content-addressed identity, and the canonical
    // form still resolves through CFC verified-source (set + lookup agree after
    // normalization — they both gain the same leading slash).
    expect(r.src).toMatch(/^cf:module\//);
    expect(r.verifiedLoadId).toBeDefined();
    expect(r.isVerifiedSourceInLoad).toBe(true);
    expect(r.kind).toBe("verified");
    // The scheduler's content-addressed implementation hash also resolves:
    // `fn.src` reduces to the pure per-module code identity
    // `cf:module/<hash>:line:col` (no `/path` segment). Without it,
    // reload-stable action identity breaks.
    expect(r.implHash).toMatch(/^cf:module\/[^/]+:\d+:\d+$/);
  });
});
