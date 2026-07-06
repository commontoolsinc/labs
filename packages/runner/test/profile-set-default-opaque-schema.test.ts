import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import { fromFileUrl } from "@std/path";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";

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

const compilePattern = async (runtime: Runtime, rel: string) => {
  const repoRoot = new URL("../../..", import.meta.url).pathname.replace(
    /\/$/,
    "",
  );
  const sourcePath = new URL(rel, import.meta.url).pathname;
  const program = await runtime.harness.resolve(
    new FileSystemProgramResolver(sourcePath, repoRoot),
  );
  return await runtime.patternManager.compilePattern(program);
};

const compileHomePattern = (runtime: Runtime) =>
  compilePattern(runtime, "../../patterns/system/home.tsx");

// A wrapper that imports the REAL `setDefaultProfile` handler from profile-create.tsx and
// exposes ITS binding as a top-level output node, so the handler's argument
// schema (the write-authorization schema CFC walks at runtime) lands in
// `pattern.nodes[].module.argumentSchema` for inspection. This reaches the
// ACTUAL walked write target — the handler's own declared `defaultProfile` state
// param — which is NOT a top-level node of the real profile-picker.tsx (there it
// is created inside the rendered onClick VNode).
const sysDir = fromFileUrl(new URL("../../patterns/system/", import.meta.url));
const read = (n: string) => Deno.readTextFileSync(sysDir + n);

// The wrapper deliberately does NOT depend on any fix-only exported type: it
// binds `setDefaultProfile` with `as any` state, so it compiles on origin/main
// too. What's inspected is the REAL handler's OWN declared argument schema
// (profile-create.tsx `setDefaultProfile` state param) — the fix's lever — so
// the test is ASSERTION-gated (walkable vs opaque), never compile-gated.
const HANDLER_WRAPPER_SRC = [
  "import ProfileCreate, {",
  "  setDefaultProfile,",
  "} from './profile-create.tsx';",
  "import { pattern, Writable } from 'commonfabric';",
  "import type { ProfileHomeOutput } from './profile-home.tsx';",
  "",
  "type WrapperOutput = {",
  "  profiles: Writable<ProfileHomeOutput[]>;",
  "  defaultProfile: unknown;",
  "  setDefaultBinding: unknown;",
  "};",
  "",
  "export default pattern<Record<never, never>, WrapperOutput>(() => {",
  "  const profiles = new Writable<ProfileHomeOutput[]>([]).for('profiles');",
  "  const defaultProfile = new Writable<Record<never, never> | undefined>(",
  "    undefined,",
  "  ).for('defaultProfile');",
  "  ProfileCreate({ profiles });",
  "  return {",
  "    profiles: profiles as any,",
  "    defaultProfile: defaultProfile as any,",
  "    setDefaultBinding: setDefaultProfile({",
  "      defaultProfile: defaultProfile as any,",
  "      profile: profiles.key(0) as any,",
  "    }),",
  "  };",
  "});",
].join("\n");

const handlerWrapperProgram = (): RuntimeProgram => ({
  main: "/main.tsx",
  files: [
    { name: "/main.tsx", contents: HANDLER_WRAPPER_SRC },
    { name: "/profile-create.tsx", contents: read("profile-create.tsx") },
    { name: "/profile-home.tsx", contents: read("profile-home.tsx") },
  ],
});

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

  // THE walked site: at RUNTIME CFC derives the write-authorization schema for
  // the `setDefaultProfile` write from the HANDLER's OWN declared argument schema
  // — the `defaultProfile` state param — which becomes the `asCell:["writeonly"]`
  // write target. This compiles a wrapper that exposes the REAL
  // `setDefaultProfile` binding as a top-level node (so its argument schema lands
  // in `pattern.nodes[].module.argumentSchema`) and asserts that write target is
  // opaque — carries NO owner-protected `/avatar`/`name`/`bio` to walk.
  //
  // Pre-fix the handler's state param is `Writable<ProfileHomeOutput |
  // undefined>`, so the write target is `anyOf:[undefined,{$ref:ProfileHomeOutput}]`
  // — walkable owner-protected `/avatar` present — RED. Post-fix it is the opaque
  // `DefaultProfileCell` — bare `{asCell:["writeonly"]}` — GREEN. This is the
  // tightest headless proxy for the in-browser overwrite (which can't run
  // end-to-end headlessly: the picker `.map` handler binding collapses distinct
  // rows to one shared argument-cell redirect, so a full overwrite drive silently
  // no-ops). The wrapper mirrors the picker binding
  // (`setDefaultProfile({ defaultProfile, profile })`) exactly.
  it("the setDefaultProfile handler's write target is opaque (no owner-protected /avatar)", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const wrapper = await runtime.patternManager.compilePattern(
        handlerWrapperProgram(),
      );
      // deno-lint-ignore no-explicit-any
      const nodes = (wrapper as any).nodes as Array<{
        // deno-lint-ignore no-explicit-any
        module?: { wrapper?: string; argumentSchema?: any };
      }>;
      expect(Array.isArray(nodes)).toBe(true);

      // Every handler node whose `$ctx` (handler state) declares a
      // `defaultProfile` write target — i.e. the `setDefaultProfile` binding. The
      // handler's state lives under `argumentSchema.properties.$ctx`; the
      // `defaultProfile` there is the `asCell:["writeonly"]` write target CFC
      // walks at runtime.
      const defaultWriteTargets = nodes
        .map((n) => n.module?.argumentSchema)
        .filter((schema) => schema && typeof schema === "object")
        .map((schema) => ({
          root: schema,
          ctx: schema.properties?.$ctx,
        }))
        .filter(({ ctx }) =>
          ctx && typeof ctx === "object" &&
          ctx.properties?.defaultProfile !== undefined
        );
      // The wrapper binds setDefaultProfile exactly once.
      expect(defaultWriteTargets.length).toBeGreaterThan(0);

      for (const { root, ctx } of defaultWriteTargets) {
        const slot = ctx.properties.defaultProfile;
        // Resolve `$ref`s against the ARGUMENT schema's `$defs` (where the
        // handler's referenced types live).
        const ownerProtected = collectOwnerProtectedPaths(root, slot);
        expect(ownerProtected).not.toContain("avatar");
        expect(ownerProtected).not.toContain("name");
        expect(ownerProtected).not.toContain("bio");
        expect(ownerProtected.length).toBe(0);
      }
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
