import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import type { NormalizedFullLink } from "../src/link-utils.ts";
import { getVerifiedProvenance } from "../src/harness/verified-provenance.ts";

const alice = await Identity.fromPassphrase(
  "runner-profile-owner-cfc-alice",
);
const bob = await Identity.fromPassphrase("runner-profile-owner-cfc-bob");

const PROFILE_WRITER = "system.profile-home";
const PROFILE_LINK_CELL_SCHEMA: JSONSchema = {
  type: "unknown",
  asCell: ["cell"],
};

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

const resolveSchemaWithRootDefs = (
  root: JSONSchema,
  schema: JSONSchema,
): JSONSchema => {
  const resolved = resolveLocalSchemaRef(root, schema);
  if (
    typeof resolved !== "object" || resolved === null ||
    typeof root !== "object" || root === null
  ) {
    return resolved;
  }
  return {
    ...resolved,
    $defs: (root as { $defs?: Record<string, JSONSchema> }).$defs,
  };
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

const verifiedIdentityForBinding = (
  runtime: Runtime,
  bindingPath: string[],
) => {
  const registry = (runtime.harness as unknown as {
    executableRegistry: {
      verifiedImplementationsByEntryRef: Map<string, Map<string, unknown>>;
    };
  }).executableRegistry;
  for (const bucket of registry.verifiedImplementationsByEntryRef.values()) {
    for (const implementation of bucket.values()) {
      const provenance = getVerifiedProvenance(implementation);
      if (provenance === undefined) {
        continue;
      }
      const identity = provenance.bindingIdentity;
      if (
        identity !== undefined &&
        identity.bindingPath.length === bindingPath.length &&
        identity.bindingPath.every((entry, index) =>
          entry === bindingPath[index]
        )
      ) {
        return {
          kind: "verified" as const,
          moduleIdentity: provenance.identity,
          sourceFile: identity.sourceFile,
          bindingPath: identity.bindingPath,
        };
      }
    }
  }
  throw new Error(`Verified binding not found: ${bindingPath.join(".")}`);
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
        origin: "declared",
      });
      expect(stored.cfc?.labelMap?.entries).toContainEqual({
        path: ["avatar"],
        label: { integrity: [ownerAtom(alice.did())] },
        origin: "declared",
      });
      expect(stored.cfc?.labelMap?.entries).toContainEqual({
        path: ["elements"],
        label: { integrity: [ownerAtom(alice.did())] },
        origin: "declared",
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

  // A mergeable array op (add-unique / remove-by-value) records the same schema
  // write-policy input and produces the same array-path write as a whole-value
  // `set`, so the owner-write authorization applies to it unchanged. An
  // owner-protected string list keeps the assertion on the op itself, not on the
  // keyed-entity machinery.
  const ownerProtectedTagList = (ownerDid: string): JSONSchema => ({
    type: "object",
    properties: {
      tags: {
        type: "array",
        items: { type: "string" },
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
      },
    },
    required: ["tags"],
  });

  it("authorizes mergeable add-unique and remove-by-value on an owner-protected list", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const schema = ownerProtectedTagList(alice.did());
      const seed = runtime.edit();
      setTrustedProfileWriter(seed, alice.did());
      const seedCell = runtime.getCell(
        alice.did(),
        "cfc-mergeable-list",
        schema,
        seed,
      );
      seedCell.set({ tags: [] });
      const target = seedCell.getAsNormalizedFullLink();
      recordTrustedEdit(seed, target, ["tags"]);
      seed.prepareCfc();
      expect((await seed.commit()).ok).toBeDefined();

      // The authorized writer adds through the mergeable op.
      const add = runtime.edit();
      setTrustedProfileWriter(add, alice.did());
      runtime.getCell(alice.did(), "cfc-mergeable-list", schema, add)
        .key("tags").addUnique("x");
      recordTrustedEdit(add, target, ["tags"]);
      add.prepareCfc();
      expect((await add.commit()).error).toBeUndefined();

      // ...and removes through the mergeable op.
      const rm = runtime.edit();
      setTrustedProfileWriter(rm, alice.did());
      runtime.getCell(alice.did(), "cfc-mergeable-list", schema, rm)
        .key("tags").removeByValue("x");
      recordTrustedEdit(rm, target, ["tags"]);
      rm.prepareCfc();
      expect((await rm.commit()).error).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects an unauthorized mergeable write to an owner-protected list", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const schema = ownerProtectedTagList(alice.did());
      const seed = runtime.edit();
      setTrustedProfileWriter(seed, alice.did());
      const seedCell = runtime.getCell(
        alice.did(),
        "cfc-mergeable-list-rejected",
        schema,
        seed,
      );
      seedCell.set({ tags: [] });
      const target = seedCell.getAsNormalizedFullLink();
      recordTrustedEdit(seed, target, ["tags"]);
      seed.prepareCfc();
      expect((await seed.commit()).ok).toBeDefined();

      // Bob add-uniques to Alice's owner-protected list: the mergeable op is
      // gated by the same ownerPrincipal check as a whole-value set.
      const tx = runtime.edit();
      setTrustedProfileWriter(tx, bob.did());
      runtime.getCell(alice.did(), "cfc-mergeable-list-rejected", schema, tx)
        .key("tags").addUnique("x");
      recordTrustedEdit(tx, target, ["tags"]);
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

  it("marks the home profiles list as integrity-protected data", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const homePattern = await compileHomePattern(runtime);
      const rootSchema = homePattern.resultSchema as JSONSchema;
      // Protection lives on the array *elements* (TrustedProfileLink), not the
      // array container — so resolve `profiles.items` and assert there.
      const profilesSchema = resolveLocalSchemaRef(
        rootSchema,
        (rootSchema as { properties?: Record<string, JSONSchema> }).properties
          ?.profiles ?? {},
      ) as { type?: string; items?: JSONSchema };
      expect(profilesSchema.type).toBe("array");
      const itemSchema = resolveLocalSchemaRef(
        rootSchema,
        profilesSchema.items ?? {},
      ) as { ifc?: { addIntegrity?: unknown[]; writeAuthorizedBy?: unknown } };
      expect(itemSchema.ifc?.addIntegrity).toContain("profile-link");
      expect(itemSchema.ifc?.writeAuthorizedBy).toBeDefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("marks the home default profile as picker-protected data", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const homePattern = await compileHomePattern(runtime);
      const rootSchema = homePattern.resultSchema as JSONSchema;
      const properties =
        (rootSchema as { properties?: Record<string, JSONSchema> })
          .properties ?? {};
      const defaultProfileSchema = resolveLocalSchemaRef(
        rootSchema,
        properties.defaultProfile ?? {},
      ) as {
        anyOf?: JSONSchema[];
        ifc?: {
          addIntegrity?: unknown[];
          writeAuthorizedBy?: unknown;
          uiContract?: unknown;
        };
      };
      expect(
        defaultProfileSchema.anyOf?.some((branch) =>
          (branch as { type?: unknown }).type === "undefined"
        ),
      ).toBe(true);
      expect(defaultProfileSchema.ifc?.addIntegrity).toContain("profile-link");
      expect(defaultProfileSchema.ifc?.writeAuthorizedBy).toEqual({
        __ctWriterIdentityOf: {
          file: "/packages/patterns/system/profile-create.tsx",
          path: ["setDefaultProfile"],
        },
      });
      expect(defaultProfileSchema.ifc?.uiContract).toEqual({
        helper: "UiAction",
        action: "SetDefaultProfile",
        trustedPattern: "ProfilePickerSurface",
        requiredEventIntegrity: ["ProfilePickerSurface"],
      });
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

      for (const field of ["name", "avatar", "externalLinks", "elements"]) {
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

  it("rejects direct untrusted writes to the home profiles list", async () => {
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
      protectedHomeDefault.key("profiles").set([profileDefault]);
      writeTx.prepareCfc();
      const result = await writeTx.commit();
      expect(result.error?.message).toContain("trusted");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects direct untrusted writes to the home default profile", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const homePattern = await compileHomePattern(runtime);
      const tx = runtime.edit();
      runtime.getCell(
        alice.did(),
        "home-default-profile-untrusted",
        homePattern.resultSchema,
        tx,
      );
      const profileDefault = runtime.getCell(
        alice.did(),
        "home-default-profile-untrusted-target",
        undefined,
        tx,
      );
      profileDefault.set({
        name: "Ada",
        avatar: "",
        bio: "",
        elements: [],
      });
      await tx.commit();

      const writeTx = runtime.edit();
      const protectedHomeDefault = runtime.getCell(
        alice.did(),
        "home-default-profile-untrusted",
        homePattern.resultSchema,
        writeTx,
      );
      protectedHomeDefault.key("defaultProfile").set(profileDefault);
      writeTx.prepareCfc();
      const result = await writeTx.commit();
      expect(result.error?.message).toContain("trusted");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects direct untrusted clears of the home default profile", async () => {
    const storageManager = StorageManager.emulate({ as: alice });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "disabled",
    });
    try {
      const homePattern = await compileHomePattern(runtime);
      const rootSchema = homePattern.resultSchema as JSONSchema;
      const properties =
        (rootSchema as { properties?: Record<string, JSONSchema> })
          .properties ?? {};
      const trustedDefaultProfileSchema = resolveSchemaWithRootDefs(
        rootSchema,
        properties.defaultProfile ?? {},
      );
      const seed = runtime.edit();
      seed.setCfcEnforcementMode("observe");
      const initializedHome = runtime.getCell(
        alice.did(),
        "home-default-profile-clear",
        homePattern.resultSchema,
        seed,
      );
      runtime.runner.run(
        seed,
        homePattern,
        {},
        initializedHome,
      );
      seed.prepareCfc();
      const seedResult = await seed.commit();
      expect(seedResult.error).toBeUndefined();

      const seedDefault = runtime.edit();
      seedDefault.setCfcEnforcementMode("enforce-explicit");
      seedDefault.setCfcTrustSnapshot({
        id: "trusted-default-profile-seed",
        actingPrincipal: alice.did(),
      });
      seedDefault.setCfcImplementationIdentity(
        verifiedIdentityForBinding(runtime, ["setDefaultProfile"]),
      );
      const profileDefault = runtime.getCell(
        alice.did(),
        "home-default-profile-clear-target",
        undefined,
        seedDefault,
      );
      profileDefault.set({
        name: "Ada",
        avatar: "",
        bio: "",
        elements: [],
      });
      const home = runtime.getCell(
        alice.did(),
        "home-default-profile-clear",
        homePattern.resultSchema,
        seedDefault,
      );
      const trustedDefaultProfile = home.key("defaultProfile")
        .resolveAsCell()
        .asSchema(trustedDefaultProfileSchema);
      trustedDefaultProfile.set(profileDefault);
      const trustedDefaultTarget = trustedDefaultProfile
        .getAsNormalizedFullLink();
      seedDefault.recordCfcWritePolicyInput({
        kind: "trusted-event",
        target: {
          space: trustedDefaultTarget.space,
          scope: trustedDefaultTarget.scope,
          id: trustedDefaultTarget.id,
          path: [],
        },
        eventId: "trusted-default-profile-seed-event",
        provenance: {
          origin: "dom",
          trusted: true,
          ui: {
            pattern: "ProfilePickerSurface",
            eventIntegrity: ["ProfilePickerSurface"],
            uiContractDataset: { uiAction: "SetDefaultProfile" },
          },
        },
      });
      seedDefault.prepareCfc();
      const seedDefaultResult = await seedDefault.commit();
      expect(seedDefaultResult.error).toBeUndefined();

      const trustedSchemaWriteTx = runtime.edit();
      trustedSchemaWriteTx.setCfcEnforcementMode("enforce-explicit");
      trustedSchemaWriteTx.setCfcTrustSnapshot({
        id: "untrusted-default-profile-clear",
        actingPrincipal: alice.did(),
      });
      const trustedSchemaDefaultProfile = runtime.getCellFromLink(
        trustedDefaultTarget,
        trustedDefaultProfileSchema,
        trustedSchemaWriteTx,
      );
      expect(
        runtime.getCellFromLink(
          trustedDefaultTarget,
          PROFILE_LINK_CELL_SCHEMA,
          trustedSchemaWriteTx,
        ).get(),
      ).toBeDefined();
      const trustedSchemaAndHash = internSchema(
        trustedDefaultProfileSchema,
        true,
      );
      trustedSchemaWriteTx.recordCfcWritePolicyInput({
        kind: "schema",
        target: {
          space: trustedDefaultTarget.space,
          scope: trustedDefaultTarget.scope,
          id: trustedDefaultTarget.id,
          path: [...trustedDefaultTarget.path],
        },
        schemaHash: trustedSchemaAndHash.taggedHashString,
        schema: trustedSchemaAndHash.schema,
      });
      trustedSchemaDefaultProfile.set(undefined);
      trustedSchemaWriteTx.prepareCfc();
      const trustedSchemaResult = await trustedSchemaWriteTx.commit();
      expect(trustedSchemaResult.error?.message).toContain(
        "writeAuthorizedBy requires a trusted verified binding identity",
      );

      const genericWriteTx = runtime.edit();
      genericWriteTx.setCfcEnforcementMode("enforce-explicit");
      const genericDefaultProfile = runtime.getCellFromLink(
        trustedDefaultTarget,
        PROFILE_LINK_CELL_SCHEMA,
        genericWriteTx,
      );
      expect(genericDefaultProfile.get()).toBeDefined();
      genericDefaultProfile.set(undefined);
      genericWriteTx.prepareCfc();
      const genericResult = await genericWriteTx.commit();
      expect(genericResult.error?.message).toContain("missing schema");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects untrusted truncation/removal of the home profiles list", async () => {
    // Element-level protection only gates *changed* elements of the new array,
    // so a shrink (set([]) / dropping an entry) would otherwise be unmediated.
    // The container-level writeAuthorizedBy must reject it.
    const { runtime, storageManager } = createRuntime();
    try {
      const homePattern = await compileHomePattern(runtime);
      // Seed a non-empty profiles list WITHOUT enforcement (no prepareCfc).
      const seed = runtime.edit();
      const profileA = runtime.getCell(
        alice.did(),
        "home-profiles-truncate-A",
        undefined,
        seed,
      );
      profileA.set({ name: "Ada", avatar: "", elements: [] });
      const home = runtime.getCell(
        alice.did(),
        "home-profiles-truncate",
        homePattern.resultSchema,
        seed,
      );
      home.key("profiles").set([profileA]);
      await seed.commit();

      // Untrusted truncation under enforcement → rejected by the container
      // writeAuthorizedBy (the array value changed [A] -> []).
      const writeTx = runtime.edit();
      const protectedHome = runtime.getCell(
        alice.did(),
        "home-profiles-truncate",
        homePattern.resultSchema,
        writeTx,
      );
      protectedHome.key("profiles").set([]);
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

  it("allows initializing owner-protected fields marked as a pattern setup projection", async () => {
    // When the runtime instantiates a pattern whose result declares
    // owner-protected fields, it records a `runtime.setup.result-projection`
    // marker whose `sources` point at the cells holding those fields. A creating
    // context that is not the per-field edit handler may then initialize them:
    // `writeAuthorizedBy` is a modification gate, not a creation gate (CFC spec
    // §8.15.4 / §8.15.10). This exercises that exemption directly: an identity
    // that does NOT satisfy `writeAuthorizedBy` is allowed solely because the
    // owner-protected fields are recorded as this pattern's setup projection.
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      tx.setCfcTrustSnapshot({
        id: "setup-projection",
        actingPrincipal: alice.did(),
      });
      tx.setCfcImplementationIdentity({
        kind: "builtin",
        builtinId: "system.not-the-profile-writer",
      });
      const cell = runtime.getCell(
        alice.did(),
        "owner-init-setup-projection",
        profileSchema(alice.did()),
        tx,
      );
      cell.set({ name: "Ada", avatar: "", elements: [] });
      const target = cell.getAsNormalizedFullLink();
      recordTrustedEdit(tx, target, ["name"]);
      recordTrustedEdit(tx, target, ["avatar"]);
      recordTrustedEdit(tx, target, ["elements"]);
      // The pattern's result cell redirects these owner-protected fields to
      // `cell`; record the trusted setup-projection marker with `cell` as the
      // redirect source, as the runtime does during instantiation.
      const resultCell = runtime.getCell(
        alice.did(),
        "owner-init-setup-projection-result",
        undefined,
        tx,
      );
      const resultTarget = resultCell.getAsNormalizedFullLink();
      for (const path of [["name"], ["avatar"], ["elements"]]) {
        tx.recordCfcWritePolicyInput({
          kind: "structural-provenance",
          target: {
            space: resultTarget.space,
            scope: resultTarget.scope,
            id: resultTarget.id,
            path,
          },
          claim: "runtime.setup.result-projection",
          sources: [{
            space: target.space,
            scope: target.scope,
            id: target.id,
            path,
          }],
        });
      }
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects the same owner-protected write without a setup-projection marker", async () => {
    // Negative twin of the test above: identical write under a non-writer
    // identity, but WITHOUT recording the setup-projection marker. Proves the
    // marker is load-bearing — the exemption is not an unconditional bypass.
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      tx.setCfcTrustSnapshot({ id: "no-marker", actingPrincipal: alice.did() });
      tx.setCfcImplementationIdentity({
        kind: "builtin",
        builtinId: "system.not-the-profile-writer",
      });
      const cell = runtime.getCell(
        alice.did(),
        "owner-init-no-marker",
        profileSchema(alice.did()),
        tx,
      );
      cell.set({ name: "Ada", avatar: "", elements: [] });
      const target = cell.getAsNormalizedFullLink();
      recordTrustedEdit(tx, target, ["name"]);
      recordTrustedEdit(tx, target, ["avatar"]);
      recordTrustedEdit(tx, target, ["elements"]);
      // No setup-projection marker recorded.
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain("writeAuthorizedBy");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("verifies writeAuthorizedBy per field against the authoring identity", async () => {
    // Two protected fields on one cell, each authorized by a different builtin,
    // written under their respective identities. writeAuthorizedBy must be
    // verified per field against the identity that authored that field's write,
    // not collapsed to the first identity seen for the cell.
    const twoFieldSchema: JSONSchema = {
      type: "object",
      properties: {
        x: { type: "string", ifc: { writeAuthorizedBy: ["writer.x"] } },
        y: { type: "string", ifc: { writeAuthorizedBy: ["writer.y"] } },
      },
      required: ["x", "y"],
    };
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      tx.setCfcTrustSnapshot({ id: "per-path", actingPrincipal: alice.did() });
      const cell = runtime.getCell(
        alice.did(),
        "per-path-identity",
        twoFieldSchema,
        tx,
      );
      tx.setCfcImplementationIdentity({
        kind: "builtin",
        builtinId: "writer.x",
      });
      cell.key("x").set("vx");
      tx.setCfcImplementationIdentity({
        kind: "builtin",
        builtinId: "writer.y",
      });
      cell.key("y").set("vy");
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects a field written under another field's authorized identity", async () => {
    // Field y written under writer.x (authorized only for x). Must be rejected:
    // the per-field identity must not be borrowed from another field's write.
    const twoFieldSchema: JSONSchema = {
      type: "object",
      properties: {
        x: { type: "string", ifc: { writeAuthorizedBy: ["writer.x"] } },
        y: { type: "string", ifc: { writeAuthorizedBy: ["writer.y"] } },
      },
      required: ["x", "y"],
    };
    const { runtime, storageManager } = createRuntime();
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-explicit");
      tx.setCfcTrustSnapshot({
        id: "per-path-neg",
        actingPrincipal: alice.did(),
      });
      const cell = runtime.getCell(
        alice.did(),
        "per-path-identity-neg",
        twoFieldSchema,
        tx,
      );
      // Both fields written under writer.x; y is not authorized for writer.x.
      tx.setCfcImplementationIdentity({
        kind: "builtin",
        builtinId: "writer.x",
      });
      cell.key("x").set("vx");
      cell.key("y").set("vy");
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain("writeAuthorizedBy");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
