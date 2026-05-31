import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import type { NormalizedFullLink } from "../src/link-utils.ts";

const alice = await Identity.fromPassphrase(
  "runner-profile-owner-cfc-alice",
);
const bob = await Identity.fromPassphrase("runner-profile-owner-cfc-bob");

const PROFILE_WRITER = "system.profile-home";

const ownerAtom = (ownerDid: string) => ({
  kind: "represents-principal",
  subject: ownerDid,
});

const ownerProtectedString = (ownerDid: string): JSONSchema => ({
  type: "string",
  ifc: {
    ownerPrincipal: ownerDid,
    addIntegrity: [ownerAtom(ownerDid)],
    writeAuthorizedBy: [PROFILE_WRITER],
    uiContract: {
      helper: "UiAction",
      action: "EditProfile",
      trustedPattern: "ProfileHome",
      requiredEventIntegrity: ["ProfileHome"],
    },
  },
});

const ownerProtectedElements = (ownerDid: string): JSONSchema => ({
  type: "array",
  items: {
    type: "object",
    properties: {
      tag: { type: "string" },
      userTags: {
        type: "array",
        items: { type: "string" },
      },
    },
  },
  ifc: {
    ownerPrincipal: ownerDid,
    addIntegrity: [ownerAtom(ownerDid)],
    writeAuthorizedBy: [PROFILE_WRITER],
    uiContract: {
      helper: "UiAction",
      action: "EditProfile",
      trustedPattern: "ProfileHome",
      requiredEventIntegrity: ["ProfileHome"],
    },
  },
});

const profileSchema = (ownerDid: string): JSONSchema => ({
  type: "object",
  properties: {
    name: ownerProtectedString(ownerDid),
    avatar: ownerProtectedString(ownerDid),
    elements: ownerProtectedElements(ownerDid),
  },
  required: ["name", "avatar", "elements"],
});

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
  const sourcePath = new URL(
    "../../patterns/system/home.tsx",
    import.meta.url,
  ).pathname;
  const program = await runtime.harness.resolve(
    new FileSystemProgramResolver(sourcePath, repoRoot),
  );
  return await runtime.patternManager.compilePattern(program);
};

const compileProfileHomePattern = async (runtime: Runtime) => {
  const repoRoot = new URL("../../..", import.meta.url).pathname.replace(
    /\/$/,
    "",
  );
  const sourcePath = new URL(
    "../../patterns/system/profile-home.tsx",
    import.meta.url,
  ).pathname;
  const program = await runtime.harness.resolve(
    new FileSystemProgramResolver(sourcePath, repoRoot),
  );
  return await runtime.patternManager.compilePattern(program);
};

const resolveLocalSchemaRef = (root: JSONSchema, schema: JSONSchema) => {
  const ref = (schema as { $ref?: string }).$ref;
  if (!ref?.startsWith("#/$defs/")) {
    return schema;
  }
  const defName = ref.slice("#/$defs/".length);
  return (root as { $defs?: Record<string, JSONSchema> }).$defs?.[defName] ??
    schema;
};

const setTrustedProfileWriter = (
  tx: IExtendedStorageTransaction,
  actingPrincipal?: string,
) => {
  tx.setCfcEnforcementMode("enforce-explicit");
  if (actingPrincipal !== undefined) {
    tx.setCfcTrustSnapshot({
      id: `profile-trust-${actingPrincipal}`,
      actingPrincipal,
    });
  }
  tx.setCfcImplementationIdentity({
    kind: "builtin",
    builtinId: PROFILE_WRITER,
  });
};

const recordTrustedEdit = (
  tx: IExtendedStorageTransaction,
  target: NormalizedFullLink,
  path: string[],
) => {
  tx.recordCfcWritePolicyInput({
    kind: "trusted-event",
    target: {
      space: target.space,
      scope: target.scope,
      id: target.id,
      path,
    },
    eventId: `trusted-profile-edit-${path.join("-")}`,
    provenance: {
      origin: "dom",
      trusted: true,
      ui: {
        pattern: "ProfileHome",
        eventIntegrity: ["ProfileHome"],
        uiContractDataset: { uiAction: "EditProfile" },
      },
    },
  });
};

describe("profile owner CFC policy", () => {
  it("persists Alice owner integrity on profile default fields", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      setTrustedProfileWriter(tx, alice.did());

      const cell = runtime.getCell(
        alice.did(),
        "profile-owner-cfc-alice",
        profileSchema(alice.did()),
        tx,
      );
      cell.set({ name: "Ada", avatar: "ada.png", elements: [] });
      const target = cell.getAsNormalizedFullLink();
      recordTrustedEdit(tx, target, ["name"]);
      recordTrustedEdit(tx, target, ["avatar"]);
      recordTrustedEdit(tx, target, ["elements"]);

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.ok).toBeDefined();

      const verify = runtime.edit();
      const stored = verify.readOrThrow({
        space: target.space,
        scope: target.scope,
        id: target.id,
        path: [],
      }) as { cfc?: { labelMap?: { entries?: unknown[] } } };
      expect(stored.cfc?.labelMap?.entries).toContainEqual({
        path: ["name"],
        label: { integrity: [ownerAtom(alice.did())] },
      });
      expect(stored.cfc?.labelMap?.entries).toContainEqual({
        path: ["avatar"],
        label: { integrity: [ownerAtom(alice.did())] },
      });
      expect(stored.cfc?.labelMap?.entries).toContainEqual({
        path: ["elements"],
        label: { integrity: [ownerAtom(alice.did())] },
      });
      verify.abort();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("keeps an authorized write valid after a later same-tx run changes the implementation identity", async () => {
    // Mirrors running a child pattern inline in the same transaction: the
    // handler authorizes a protected write under its identity, then a later run
    // changes the transaction's implementation identity. The earlier write was
    // valid when made and must stay valid — CFC must verify each write against
    // the identity that was active when it was recorded, not the last one.
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      setTrustedProfileWriter(tx, alice.did());
      const cell = runtime.getCell(
        alice.did(),
        "profile-owner-cfc-identity-clobber",
        profileSchema(alice.did()),
        tx,
      );
      cell.set({ name: "Ada", avatar: "ada.png", elements: [] });
      const target = cell.getAsNormalizedFullLink();
      recordTrustedEdit(tx, target, ["name"]);
      recordTrustedEdit(tx, target, ["avatar"]);
      recordTrustedEdit(tx, target, ["elements"]);

      // A second run in the same transaction (e.g. an inline child pattern)
      // changes the transaction-level implementation identity.
      tx.setCfcImplementationIdentity({
        kind: "builtin",
        builtinId: "system.unrelated-writer",
      });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects Bob writing Alice's protected profile fields", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const seed = runtime.edit();
      setTrustedProfileWriter(seed, alice.did());
      const seededCell = runtime.getCell(
        alice.did(),
        "profile-owner-cfc-bob-rejected",
        profileSchema(alice.did()),
        seed,
      );
      seededCell.set({ name: "Ada", avatar: "ada.png", elements: [] });
      const target = seededCell.getAsNormalizedFullLink();
      recordTrustedEdit(seed, target, ["name"]);
      recordTrustedEdit(seed, target, ["avatar"]);
      recordTrustedEdit(seed, target, ["elements"]);
      seed.prepareCfc();
      expect((await seed.commit()).ok).toBeDefined();

      const tx = runtime.edit();
      setTrustedProfileWriter(tx, bob.did());
      const cell = runtime.getCell(
        alice.did(),
        "profile-owner-cfc-bob-rejected",
        profileSchema(alice.did()),
        tx,
      );
      cell.key("name").set("Mallory");
      recordTrustedEdit(tx, target, ["name"]);

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain("ownerPrincipal");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects unauthenticated owner-protected profile writes", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      tx.setCfcTrustSnapshot(undefined);
      tx.setCfcImplementationIdentity({
        kind: "builtin",
        builtinId: PROFILE_WRITER,
      });
      const cell = runtime.getCell(
        alice.did(),
        "profile-owner-cfc-unauthenticated",
        profileSchema(alice.did()),
        tx,
      );
      cell.set({ name: "Ada", avatar: "ada.png", elements: [] });
      const target = cell.getAsNormalizedFullLink();
      recordTrustedEdit(tx, target, ["name"]);
      recordTrustedEdit(tx, target, ["avatar"]);
      recordTrustedEdit(tx, target, ["elements"]);

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain("ownerPrincipal");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects untrusted owner-protected profile writes", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      tx.setCfcTrustSnapshot({
        id: "profile-trust-untrusted",
        actingPrincipal: alice.did(),
      });

      const cell = runtime.getCell(
        alice.did(),
        "profile-owner-cfc-untrusted",
        profileSchema(alice.did()),
        tx,
      );
      cell.set({ name: "Ada", avatar: "ada.png", elements: [] });
      const target = cell.getAsNormalizedFullLink();
      recordTrustedEdit(tx, target, ["name"]);
      recordTrustedEdit(tx, target, ["avatar"]);
      recordTrustedEdit(tx, target, ["elements"]);

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain(
        "writeAuthorizedBy requires a trusted builtin identity",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects ownerPrincipal schemas without matching integrity claims", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      tx.setCfcTrustSnapshot({
        id: "profile-trust-owner-without-integrity",
        actingPrincipal: alice.did(),
      });
      tx.setCfcImplementationIdentity({
        kind: "builtin",
        builtinId: PROFILE_WRITER,
      });

      const cell = runtime.getCell(
        alice.did(),
        "profile-owner-cfc-without-integrity",
        {
          type: "object",
          properties: {
            name: {
              type: "string",
              ifc: {
                ownerPrincipal: alice.did(),
                writeAuthorizedBy: [PROFILE_WRITER],
              },
            },
          },
          required: ["name"],
        },
        tx,
      );
      cell.set({ name: "Ada" });

      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain("ownerPrincipal");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("marks the home profile link as integrity-protected data", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const homePattern = await compileHomePattern(runtime);
      const rootSchema = homePattern.resultSchema as JSONSchema;
      const profileSchema = resolveLocalSchemaRef(
        rootSchema,
        (rootSchema as { properties?: Record<string, JSONSchema> }).properties
          ?.profile ?? {},
      ) as { ifc?: { addIntegrity?: unknown[]; writeAuthorizedBy?: unknown } };
      expect(profileSchema.ifc?.addIntegrity).toContain("profile-link");
      expect(profileSchema.ifc?.writeAuthorizedBy).toBeDefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("marks production profile fields as owner-protected data", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const profileHomePattern = await compileProfileHomePattern(runtime);
      const rootSchema = profileHomePattern.resultSchema as JSONSchema;
      const properties =
        (rootSchema as { properties?: Record<string, JSONSchema> })
          .properties ?? {};

      for (const field of ["name", "avatar", "elements"]) {
        const fieldSchema = resolveLocalSchemaRef(
          rootSchema,
          properties[field],
        );
        const ifc = (fieldSchema as { ifc?: Record<string, unknown> }).ifc;
        expect(ifc?.ownerPrincipal).toEqual({
          __ctCurrentPrincipal: true,
        });
        expect(ifc?.addIntegrity).toContainEqual({
          kind: "represents-principal",
          subject: { __ctCurrentPrincipal: true },
        });
        expect(ifc?.writeAuthorizedBy).toBeDefined();
      }
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("allows a pattern to initialize its own owner-protected result fields during creation", async () => {
    // Reproduces the pattern-creation gap: instantiating a pattern whose result
    // declares owner-protected fields (writeAuthorizedBy bound to its own edit
    // handlers) means the runtime must project and initialize those fields
    // (avatar = "", elements = []). That trusted initialization is authored by
    // the creating context, which is NOT any of the per-field edit handlers, so
    // the writeAuthorizedBy modification gate rejects the pattern's own setup.
    // This is independent of cross-space: the same happens same-space for any
    // `aCell.set(SomePattern({}))` creation flow.
    const { runtime, storageManager } = createRuntime();
    try {
      const profileHomePattern = await compileProfileHomePattern(runtime);
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      tx.setCfcTrustSnapshot({
        id: "pattern-create",
        actingPrincipal: alice.did(),
      });
      // The creating context (e.g. a profile-create handler) is not the
      // per-field edit handler (setName/setAvatar/addElement).
      tx.setCfcImplementationIdentity({
        kind: "builtin",
        builtinId: "system.profile-create",
      });
      const resultCell = runtime.getCell(
        alice.did(),
        "pattern-create-owner-init",
        profileHomePattern.resultSchema,
        tx,
      );
      runtime.runner.run(
        tx,
        profileHomePattern,
        { initialName: "Ada" },
        resultCell,
      );
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects direct untrusted writes to the home profile link", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const homePattern = await compileHomePattern(runtime);
      const tx = runtime.edit();
      runtime.getCell(
        alice.did(),
        "home-profile-link-untrusted",
        homePattern.resultSchema,
        tx,
      );
      const profileDefault = runtime.getCell(
        alice.did(),
        "home-profile-link-untrusted-target",
        undefined,
        tx,
      );
      profileDefault.set({
        name: "Ada",
        avatar: "",
        elements: [],
      });
      await tx.commit();

      const writeTx = runtime.edit();
      const protectedHomeDefault = runtime.getCell(
        alice.did(),
        "home-profile-link-untrusted",
        homePattern.resultSchema,
        writeTx,
      );
      protectedHomeDefault.key("profile").set(profileDefault);
      writeTx.prepareCfc();
      const result = await writeTx.commit();
      expect(result.error?.message).toContain("trusted");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("does not expose a writable profile creation trigger", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const homePattern = await compileHomePattern(runtime);
      const properties =
        (homePattern.resultSchema as { properties?: Record<string, unknown> })
          .properties ?? {};
      expect(properties.requestedProfileName).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
