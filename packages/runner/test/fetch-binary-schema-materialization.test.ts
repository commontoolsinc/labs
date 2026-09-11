import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

/**
 * Regression for CT-1836: a lift consuming a `fetchBinary` result was
 * permanently gated because schema-query materialization DROPPED the
 * `FabricBytes`-bearing fetch result.
 *
 * Mechanism: `SchemaObjectTraverser`'s value dispatch had no
 * `FabricSpecialObject` arm, so a `FabricBytes` fell into the record branch
 * and was decomposed by `Object.entries` over its (empty) own props. That
 * failed the schema-generator's structural object schema for
 * `FetchBinaryResult.bytes`, the traversal dropped the containing value
 * (`required` unmet), the consumer's argument stayed invalid,
 * and its body never ran — freezing every downstream consumer, at any
 * nesting depth. (`fetchJson` consumers were unaffected: plain JSON values.)
 * The collateral: the consumers' crippled read logs also never registered
 * the forward dependents edges the post-writeback wake relies on.
 *
 * The fix treats `FabricSpecialObject` values as opaque leaves (the fabric
 * type system's documented contract: frozen, pass through conversion
 * unchanged).
 *
 * This test runs the WHOLE chain — mocked binary fetch (via the injectable
 * `RuntimeOptions.fetch`, CT-1768) → `FabricBytes` result → consumer lifts
 * reading `mediaType` and re-encoding `bytes` — and asserts
 * the consumers actually materialize. Fails without the traverse fix (both
 * outputs stay empty forever); passes with it.
 */

const signer = await Identity.fromPassphrase("fetch-binary-materialization");
const space = signer.did();

// 1×1 transparent PNG.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const TINY_PNG_BYTES = Uint8Array.from(
  atob(TINY_PNG_BASE64),
  (c) => c.charCodeAt(0),
);

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        "import { computed, fetchBinary, pattern, type FetchBinaryResult } from 'commonfabric';",
        "export default pattern(() => {",
        "  const art = fetchBinary({ url: 'https://mock.test/img' });",
        "  const readyArt = art as FetchBinaryResult;",
        "  const mediaType = computed(() => readyArt.mediaType ?? '');",
        "  const dataUrl = computed(() => {",
        "    const bytes = readyArt.bytes;",
        "    const mt = readyArt.mediaType;",
        "    if (!bytes || !mt) return '';",
        "    const raw = bytes.slice();",
        "    let binary = '';",
        "    for (let i = 0; i < raw.length; i++) {",
        "      binary += String.fromCharCode(raw[i]);",
        "    }",
        "    return `data:${mt};base64,${btoa(binary)}`;",
        "  });",
        "  return { mediaType, dataUrl };",
        "});",
      ].join("\n"),
    },
  ],
};

describe("fetchBinary consumer materialization (CT-1836)", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      // `RuntimeOptions.fetch` overrides the outbound fetch for this runtime
      // instance, so the builtin resolves against this deterministic binary
      // response instead of the network.
      fetch: () =>
        Promise.resolve(
          new Response(TINY_PNG_BYTES, {
            status: 200,
            headers: { "content-type": "image/png" },
          }),
        ),
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("lifts reading a FabricBytes-bearing fetch result materialize and run", async () => {
    const compiled = await runtime.patternManager.compilePattern(PROGRAM);
    const resultCell = runtime.getCell<{ mediaType: string; dataUrl: string }>(
      space,
      "fetch-binary-consumer",
      compiled.resultSchema,
      tx,
    );
    const result = runtime.run(tx, compiled, {}, resultCell);
    runtime.prepareTxForCommit(tx);
    await tx.commit();
    tx = runtime.edit();

    const cancelSink = result.sink(() => {});
    // `settled()` awaits the async fetch work and its writeback; a follow-up
    // `idle()` drains the consumer re-runs the writeback triggers.
    await runtime.settled();
    await runtime.idle();

    expect(await result.key("mediaType").pull()).toBe("image/png");
    expect(await result.key("dataUrl").pull()).toBe(
      `data:image/png;base64,${TINY_PNG_BASE64}`,
    );
    cancelSink();
  });
});
