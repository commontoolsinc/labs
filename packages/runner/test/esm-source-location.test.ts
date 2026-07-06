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
// (`<evalId>.js:line:col`). Otherwise the CFC provenance src check fails
// closed (canonical-source mismatch → kind "unsupported"), which breaks every
// CFC trusted action. The fix composes a per-evaluation bundle source map
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
  kind: string | undefined;
}

function probeHandlerIdentity(
  compiled: Pattern,
): HandlerIdentityProbe {
  const nodes = (compiled as Pattern & { nodes: { module: Module }[] }).nodes;
  const handlerModule = nodes
    .map((n) => n.module)
    .find((m) =>
      m && m.type === "javascript" && m.wrapper === "handler" &&
      typeof m.implementation === "function"
    );
  if (!handlerModule) {
    throw new Error("no verified handler node found in compiled pattern");
  }
  // The live module carries its implementation; identity facts ride the
  // function's provenance (the legacy implementationRef index is gone).
  const fn = handlerModule.implementation as
    | (((...a: unknown[]) => unknown) & { src?: string })
    | undefined;
  const src = fn?.src;
  const identity = resolvePolicyFacingImplementationIdentity(handlerModule, {
    implementation: fn as never,
  });
  return {
    src,
    kind: identity?.kind,
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
    const r = probeHandlerIdentity(compiled);

    // src maps back to the authored file, not a `<loadId>.js` / `:esm:` bundle.
    expect(r.src).toMatch(/(?:^|\/)main\.tsx:\d+:\d+$/);
    expect(r.src).not.toMatch(/:esm:|\.js:\d+:\d+$/);
    // src is the reload-stable content-addressed identity, and the canonical
    // form still resolves through CFC verified-source (set + lookup agree after
    // normalization — they both gain the same leading slash).
    expect(r.src).toMatch(/^cf:module\//);
    expect(r.kind).toBe("verified");
  });
});
