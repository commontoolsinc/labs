import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";

import {
  COMPILE_FINGERPRINT_INPUTS,
  computeCompilerFingerprint,
  computeCompilerVersion,
  renderVersionModule,
  SENTINEL_VERSION,
  VERSION_NAMESPACE,
} from "../src/compilation-cache/compiler-fingerprint.deno.ts";
import { COMPILE_CACHE_RUNTIME_VERSION } from "../src/compilation-cache/cell-cache.ts";

const versionModulePath = fromFileUrl(
  new URL("../src/compilation-cache/compile-cache-version.ts", import.meta.url),
);

/** Write a temp tree and return its root; caller removes it. */
async function makeTree(
  files: Record<string, string>,
): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "compile-fingerprint-" });
  for (const [rel, contents] of Object.entries(files)) {
    const abs = `${root}/${rel}`;
    await Deno.mkdir(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(abs, contents);
  }
  return root;
}

describe("computeCompilerFingerprint", () => {
  it("is stable: identical inputs hash to the same value", async () => {
    const root = await makeTree({
      "transformer/a.ts": "export const a = 1;",
      "transformer/sub/b.ts": "export const b = 2;",
    });
    try {
      const first = await computeCompilerFingerprint(root, ["transformer"]);
      const second = await computeCompilerFingerprint(root, ["transformer"]);
      expect(first).toBe(second);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("changes when a fingerprinted file's contents change", async () => {
    const root = await makeTree({
      "transformer/a.ts": "export const a = 1;",
    });
    try {
      const before = await computeCompilerFingerprint(root, ["transformer"]);
      await Deno.writeTextFile(
        `${root}/transformer/a.ts`,
        "export const a = 2;",
      );
      const after = await computeCompilerFingerprint(root, ["transformer"]);
      expect(after).not.toBe(before);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("changes when a file is added under a fingerprinted directory", async () => {
    const root = await makeTree({
      "transformer/a.ts": "export const a = 1;",
    });
    try {
      const before = await computeCompilerFingerprint(root, ["transformer"]);
      await Deno.writeTextFile(
        `${root}/transformer/c.ts`,
        "export const c = 3;",
      );
      const after = await computeCompilerFingerprint(root, ["transformer"]);
      expect(after).not.toBe(before);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("ignores walk order and CRLF/LF differences", async () => {
    const lf = await makeTree({
      "transformer/a.ts": "export const a = 1;\nexport const b = 2;\n",
    });
    const crlf = await makeTree({
      "transformer/a.ts": "export const a = 1;\r\nexport const b = 2;\r\n",
    });
    try {
      const lfHash = await computeCompilerFingerprint(lf, ["transformer"]);
      const crlfHash = await computeCompilerFingerprint(crlf, ["transformer"]);
      expect(crlfHash).toBe(lfHash);
    } finally {
      await Deno.remove(lf, { recursive: true });
      await Deno.remove(crlf, { recursive: true });
    }
  });

  it("throws on a missing input", async () => {
    const root = await makeTree({ "present/a.ts": "x" });
    try {
      await expect(computeCompilerFingerprint(root, ["absent"]))
        .rejects.toThrow();
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});

describe("compile-cache version axis", () => {
  it("from-source const is the stable sentinel under the namespace", () => {
    expect(COMPILE_CACHE_RUNTIME_VERSION).toBe(SENTINEL_VERSION);
    expect(COMPILE_CACHE_RUNTIME_VERSION).toBe(`${VERSION_NAMESPACE}/source`);
  });

  it("committed version module matches the rendered sentinel (build/fmt drift guard)", async () => {
    const onDisk = await Deno.readTextFile(versionModulePath);
    expect(onDisk).toBe(renderVersionModule(SENTINEL_VERSION));
  });

  it("a baked version over the real inputs differs from the sentinel", async () => {
    const repoRoot = fromFileUrl(new URL("../../../", import.meta.url));
    const version = await computeCompilerVersion(
      repoRoot,
      COMPILE_FINGERPRINT_INPUTS,
    );
    expect(version.startsWith(`${VERSION_NAMESPACE}/`)).toBe(true);
    expect(version).not.toBe(SENTINEL_VERSION);
  });
});
