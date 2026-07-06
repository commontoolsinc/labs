import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";

// CT-1845 (pattern-level guard): the home `defaultProfile` slot must declare an
// OPAQUE link schema, NOT the walkable `ProfileHomeOutput`.
//
// The overwrite failure (see profile-set-default-overwrite-cfc.test.ts for the
// deterministic CFC mechanism) is caused by `defaultProfile` — a SINGLE
// owner-protected slot — declaring a walkable `ProfileHomeOutput` schema. CFC
// (`walkIfcSchema`) walks that schema on every write and emits owner-protected
// entries for the target's OWN fields (`/name`, `/avatar`, `/bio`, each
// `writeAuthorizedBy: set…`). OVERWRITING the default with a different profile
// makes `ifcEntryAppliesToAttemptedWrite` treat the nested `/avatar` as
// "touched" (the container link changed) with a concrete RESOLVED value, so the
// entry APPLIES and CFC enforces `/avatar`'s `setAvatar` authorization against
// the picker writer (`setDefaultProfile`) — rejecting with `writeAuthorizedBy
// failed at /avatar`. (A first write from EMPTY has no prior resolved `/avatar`
// to touch, so it passes — the bug is overwrite-specific.)
//
// The fix declares the durable `defaultProfile` cell with the opaque
// `DefaultProfileCell` type (`Record<never, never> | undefined`), so the stored
// slot schema carries NO walkable owner-protected sub-field. This test compiles
// the REAL shipped home.tsx and asserts its `defaultProfile` output schema
// exposes no owner-protected `avatar`/`name`/`bio` sub-field. Pre-fix (walkable
// `ProfileHomeOutput`) it does — RED. Post-fix it does not — GREEN.
const alice = await Identity.fromPassphrase(
  "runner-profile-set-default-opaque-schema",
);

const createRuntime = () => {
  const storageManager = StorageManager.emulate({ as: alice });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
  });
  return { runtime, storageManager };
};

const compileHomePattern = async (runtime: Runtime) => {
  const repoRoot = new URL("../../..", import.meta.url).pathname.replace(
    /\/$/,
    "",
  );
  const sourcePath =
    new URL("../../patterns/system/home.tsx", import.meta.url).pathname;
  const program = await runtime.harness.resolve(
    new FileSystemProgramResolver(sourcePath, repoRoot),
  );
  return await runtime.patternManager.compilePattern(program);
};

// Every path (relative to the given root schema) that carries an owner-protected
// `writeAuthorizedBy` claim, resolving local `$ref`s against `$defs` exactly as
// CFC's `walkIfcSchema` does. A `$ref`-aware walk is REQUIRED: the slot schema
// is `anyOf:[{undefined},{$ref:"#/$defs/…"}]` with the owner-protected fields
// living under `$defs`, so a naive walker that skips `$ref` would miss them.
const collectOwnerProtectedPaths = (
  root: JSONSchema,
  start: JSONSchema,
): string[] => {
  // deno-lint-ignore no-explicit-any
  const defs = (root as any).$defs ?? {};
  const out: string[] = [];
  const seen = new Set<unknown>();
  const walk = (node: unknown, path: string[]) => {
    if (typeof node !== "object" || node === null) return;
    if (seen.has(node)) return;
    seen.add(node);
    // deno-lint-ignore no-explicit-any
    const n = node as any;
    if (typeof n.$ref === "string" && n.$ref.startsWith("#/$defs/")) {
      const resolved = defs[n.$ref.slice("#/$defs/".length)];
      if (resolved) walk(resolved, path);
    }
    if (n.ifc && n.ifc.writeAuthorizedBy !== undefined && path.length > 0) {
      out.push(path.join("/"));
    }
    if (n.properties && typeof n.properties === "object") {
      for (const [k, v] of Object.entries(n.properties)) walk(v, [...path, k]);
    }
    for (const key of ["anyOf", "oneOf", "allOf"]) {
      if (Array.isArray(n[key])) { for (const c of n[key]) walk(c, path); }
    }
    if (n.items && typeof n.items === "object") walk(n.items, [...path, "*"]);
    seen.delete(node);
  };
  walk(start, []);
  return out;
};

describe("profile set-default OPAQUE slot schema (REAL home.tsx) — CT-1845", () => {
  it("the home defaultProfile slot declares no owner-protected /avatar to walk", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const homePattern = await compileHomePattern(runtime);
      const rootSchema = homePattern.resultSchema as JSONSchema;
      const slot =
        (rootSchema as { properties?: Record<string, JSONSchema> }).properties
          ?.defaultProfile ?? {};

      const ownerProtected = collectOwnerProtectedPaths(rootSchema, slot);
      // The opaque slot must expose NONE of the linked profile's owner-protected
      // sub-fields. Any present means CFC walks and enforces them on an overwrite
      // — the CT-1845 bug.
      expect(ownerProtected).not.toContain("avatar");
      expect(ownerProtected).not.toContain("name");
      expect(ownerProtected).not.toContain("bio");
      expect(ownerProtected.length).toBe(0);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
