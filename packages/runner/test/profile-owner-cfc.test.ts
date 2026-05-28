import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
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
});
