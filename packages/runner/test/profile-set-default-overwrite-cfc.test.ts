import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import type { NormalizedFullLink } from "../src/link-utils.ts";

// CT-1845: "Set default" OVERWRITE fails CFC `writeAuthorizedBy` at /avatar.
//
// The prior fix (PR #4539, `defaultProfile.set(profile.getAsLink())`) was
// DISPROVEN IN-BROWSER: overwrite still fails. The stored value is always a
// pure link regardless, so #4539's guarded invariant (`isPureLinkSigil`) was
// never the cause.
//
// The bug is OVERWRITE-specific (verified in-browser):
//   - setting `defaultProfile` from EMPTY (never-set) SUCCEEDS;
//   - OVERWRITING an already-set `defaultProfile` with a DIFFERENT profile
//     FAILS with:
//       CFC enforcement rejected commit: relevant transaction was not prepared:
//       writeAuthorizedBy failed at /avatar
//
// ROOT CAUSE (packages/runner/src/cfc/prepare.ts). The home's single
// `defaultProfile` slot is typed `TrustedDefaultProfile` = a link to
// `ProfileHomeOutput`, and the WRITTEN link carries that whole walkable schema.
// `walkIfcSchema` therefore emits owner-protected entries for the linked
// target's OWN fields — `/name`, `/avatar`, `/bio` — each
// `writeAuthorizedBy: set…` (e.g. `/avatar` → `setAvatar`). On the overwrite,
// `ifcEntryAppliesToAttemptedWrite` sees the container link at `[]` change, so
// `/avatar` is "touched"; its resolved value is a concrete string, so the entry
// APPLIES (prepare.ts ~2399-2407). `verifyInputRequirements` then runs
// `writeAuthorizedByReason` for `/avatar` against the PICKER writer
// (setDefaultProfile), which is not `setAvatar`, and rejects
// (`writeAuthorizedBy failed at /avatar`). A FIRST write from empty never has a
// prior resolved `/avatar` to touch, so it passes — hence overwrite-specific.
//
// This test reproduces the failure DETERMINISTICALLY at the CFC layer (the
// runtime write-policy machinery), independent of the picker's per-row handler
// binding — the headless drive of the picker `.map`/`.key` handler collapses
// distinct rows to one shared argument-cell redirect, so a real-patterns drive
// silently no-ops the overwrite instead of landing the distinct link that
// triggers the walk (see the sibling profile-picker-overwrite integration note
// below). Here we model the exact slot shape and writer identities and assert:
//   (RED, pre-fix)  overwriting the WALKABLE owner-protected slot under the
//                   picker writer is rejected at /avatar;
//   (GREEN, w/ fix) overwriting the OPAQUE-link slot (no walkable sub-fields)
//                   under the picker writer is accepted.
//
// The shipped fix (packages/patterns/system/profile-create.tsx) is option 2:
// type `TrustedDefaultProfile` as an OPAQUE link (identity only, no walkable
// `ProfileHomeOutput` sub-fields), mirroring how MRU array elements avoid the
// walk. The read side resolves the link to the profile regardless of the slot's
// declared schema (picker/wish read via `profileLinkSchema()` `asCell`), so
// dropping the walkable sub-schema does not change resolution.

const alice = await Identity.fromPassphrase(
  "runner-profile-set-default-overwrite-alice",
);

// The picker writer (setDefaultProfile) and the avatar writer (setAvatar) are
// DISTINCT builtins — the picker cannot author `/avatar`.
const PICKER_WRITER = "system.profile-create.setDefaultProfile";
const AVATAR_WRITER = "system.profile-home.setAvatar";

const ownerAtom = (ownerDid: string) => ({
  kind: "represents-principal",
  subject: ownerDid,
});

// An owner-protected sub-field whose write is authorized by a DIFFERENT writer
// than the slot that contains it — models `ProfileHomeOutput.avatar`
// (writeAuthorizedBy setAvatar) nested under the `defaultProfile` slot
// (writeAuthorizedBy setDefaultProfile).
const avatarSubField = (ownerDid: string): JSONSchema => ({
  type: "string",
  ifc: {
    ownerPrincipal: ownerDid,
    addIntegrity: [ownerAtom(ownerDid)],
    writeAuthorizedBy: [AVATAR_WRITER],
  },
});

// The BUGGY slot shape: the single `defaultProfile` slot resolves to a walkable
// `ProfileHomeOutput` whose `/avatar` sub-field is owner-protected under a
// different writer. `walkIfcSchema` visits `/avatar` on every write to this
// slot, including a whole-slot overwrite.
const walkableDefaultProfileSlot = (ownerDid: string): JSONSchema => ({
  type: "object",
  properties: {
    defaultProfile: {
      type: "object",
      ifc: {
        // The slot itself is authorized by the picker writer.
        writeAuthorizedBy: [PICKER_WRITER],
      },
      properties: {
        // Non-protected identity-ish fields.
        name: { type: "string" },
        // The owner-protected sub-field authored by a DIFFERENT writer.
        avatar: avatarSubField(ownerDid),
      },
      required: ["name", "avatar"],
    },
  },
  required: ["defaultProfile"],
});

// The FIXED slot shape: the single `defaultProfile` slot is an OPAQUE link
// (identity only) — the picker writer authorizes it, and there are NO walkable
// owner-protected sub-fields, so `walkIfcSchema` never visits `/avatar`.
const opaqueDefaultProfileSlot = (): JSONSchema => ({
  type: "object",
  properties: {
    defaultProfile: {
      type: "object",
      ifc: {
        writeAuthorizedBy: [PICKER_WRITER],
      },
    },
  },
  required: ["defaultProfile"],
});

const createRuntime = () => {
  const storageManager = StorageManager.emulate({ as: alice });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
  });
  return { runtime, storageManager };
};

const setWriter = (
  tx: IExtendedStorageTransaction,
  builtinId: string,
  actingPrincipal: string,
) => {
  tx.setCfcEnforcementMode("enforce-explicit");
  tx.setCfcTrustSnapshot({
    id: `trust-${builtinId}`,
    actingPrincipal,
  });
  tx.setCfcImplementationIdentity({ kind: "builtin", builtinId });
};

// Records the trusted picker-surface UI-contract input for the slot write, plus
// (for the walkable shape) the avatar writer's authoring provenance so the ONLY
// thing that can reject the overwrite is the picker writer failing /avatar's
// `writeAuthorizedBy`, not a missing trust snapshot.
const recordSlotEdit = (
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
    eventId: `set-default-${path.join("-")}`,
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
};

describe("profile set-default OVERWRITE CFC — CT-1845", () => {
  it("RED (pre-fix shape): overwriting a WALKABLE owner-protected default slot under the picker writer is rejected at /avatar", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const schema = walkableDefaultProfileSlot(alice.did());

      // FIRST write from EMPTY. The slot itself is authored by the PICKER
      // writer; the nested /avatar carries the AVATAR writer's authoring
      // identity. Both are recorded per-path so the seed passes — the empty->set
      // case never fails in-browser. The picker writer legitimately establishes
      // the slot; the avatar sub-value is credited to its own writer.
      const seed = runtime.edit();
      setWriter(seed, PICKER_WRITER, alice.did());
      const cell = runtime.getCell(
        alice.did(),
        "cfc-set-default-overwrite-walkable",
        schema,
        seed,
      );
      cell.set({ defaultProfile: { name: "Ada" } });
      const target = cell.getAsNormalizedFullLink();
      recordSlotEdit(seed, target, ["defaultProfile"]);
      seed.prepareCfc();
      const seedCommit = await seed.commit();
      expect(seedCommit.error).toBeUndefined();

      // Author /avatar under the AVATAR writer (as setAvatar would, in the
      // profile's own space). After this, the slot holds a concrete /avatar.
      const av = runtime.edit();
      setWriter(av, AVATAR_WRITER, alice.did());
      const avCell = runtime.getCell(
        alice.did(),
        "cfc-set-default-overwrite-walkable",
        schema,
        av,
      );
      avCell.key("defaultProfile").key("avatar").set("ada.png");
      recordSlotEdit(av, target, ["defaultProfile", "avatar"]);
      av.prepareCfc();
      expect((await av.commit()).error).toBeUndefined();

      // OVERWRITE the slot under the PICKER writer (setDefaultProfile). The
      // picker only rewrites the slot's identity content (`name` here; in home
      // it is the container link) — NOT /avatar. But the overwrite changes the
      // container at `/defaultProfile`, so `ifcEntryAppliesToAttemptedWrite`
      // marks the nested `/defaultProfile/avatar` "touched"; its RESOLVED value
      // is the concrete `ada.png` from the seed, so the owner-protected entry
      // APPLIES and `writeAuthorizedBy: setAvatar` is enforced against the
      // picker writer — which fails. This is the CT-1845 browser failure.
      const tx = runtime.edit();
      setWriter(tx, PICKER_WRITER, alice.did());
      const cell2 = runtime.getCell(
        alice.did(),
        "cfc-set-default-overwrite-walkable",
        schema,
        tx,
      );
      cell2.key("defaultProfile").set({ name: "Grace", avatar: "grace.png" });
      recordSlotEdit(tx, target, ["defaultProfile"]);
      tx.prepareCfc();
      const result = await tx.commit();
      // Deterministic reproduction of the CT-1845 browser failure.
      expect(result.error?.message ?? "").toContain(
        "writeAuthorizedBy failed at /defaultProfile/avatar",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("GREEN (fixed shape): overwriting an OPAQUE-link default slot under the picker writer is accepted", async () => {
    const { runtime, storageManager } = createRuntime();
    try {
      const schema = opaqueDefaultProfileSlot();

      // FIRST write from EMPTY under the picker writer.
      const seed = runtime.edit();
      setWriter(seed, PICKER_WRITER, alice.did());
      const cell = runtime.getCell(
        alice.did(),
        "cfc-set-default-overwrite-opaque",
        schema,
        seed,
      );
      cell.set({ defaultProfile: { name: "Ada", avatar: "ada.png" } });
      const target = cell.getAsNormalizedFullLink();
      recordSlotEdit(seed, target, ["defaultProfile"]);
      seed.prepareCfc();
      expect((await seed.commit()).error).toBeUndefined();

      // OVERWRITE under the picker writer — no walkable /avatar sub-field, so
      // nothing demands the avatar writer. Accepted.
      const tx = runtime.edit();
      setWriter(tx, PICKER_WRITER, alice.did());
      const cell2 = runtime.getCell(
        alice.did(),
        "cfc-set-default-overwrite-opaque",
        schema,
        tx,
      );
      cell2.set({ defaultProfile: { name: "Grace", avatar: "grace.png" } });
      recordSlotEdit(tx, target, ["defaultProfile"]);
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
