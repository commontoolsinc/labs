import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { writerClaimFilesCorrespond } from "../src/cfc/writer-claim-correspondence.ts";
import { mergeCfcSchemaEnvelopes } from "../src/cfc/schema-merge.ts";
import { reportDroppedCfcRejectedWrite } from "../src/scheduler/events.ts";
import type { JSONSchema, JSONSchemaObj } from "../src/builder/types.ts";

/**
 * labs#4772 / CT-1886: `writeAuthorizedBy` anchors on `moduleIdentity` +
 * `bindingPath`; the claim's file SPELLING is resolver-dependent (the same
 * module spells `/api/patterns/system/x.tsx` from a piece-deploy compile and
 * `/patterns/system/x.tsx` from an HTTP-resolved one) and must not shear
 * authorization. These tests pin the tolerant correspondence at all three
 * sites — verification, stamping (rebind), and stored-claim reconciliation —
 * and pin that identity and path stay fail-closed (claim rotation across
 * module versions remains a conflict pending the setsrc-history delegation
 * design; see the board topic).
 */

const MODULE_IDENTITY = "profile-home-module-identity";
const PIECE_SPELLING = "/api/patterns/system/profile-home.tsx";
const HTTP_SPELLING = "/patterns/system/profile-home.tsx";
const RELATIVE_SPELLING = "api/patterns/system/profile-home.tsx";

const signer = await Identity.fromPassphrase("wab-spelling-correspondence");

describe("writerClaimFilesCorrespond", () => {
  it("accepts equal spellings, with and without the leading slash", () => {
    expect(writerClaimFilesCorrespond(PIECE_SPELLING, PIECE_SPELLING)).toBe(
      true,
    );
    expect(writerClaimFilesCorrespond(RELATIVE_SPELLING, PIECE_SPELLING)).toBe(
      true,
    );
  });

  it("accepts spellings one leading segment apart, either direction", () => {
    expect(writerClaimFilesCorrespond(PIECE_SPELLING, HTTP_SPELLING)).toBe(
      true,
    );
    expect(writerClaimFilesCorrespond(HTTP_SPELLING, PIECE_SPELLING)).toBe(
      true,
    );
    expect(writerClaimFilesCorrespond(RELATIVE_SPELLING, HTTP_SPELLING)).toBe(
      true,
    );
  });

  it("rejects unrelated files, deeper divergence, and absent sides", () => {
    expect(writerClaimFilesCorrespond("/attacker.tsx", "/victim.tsx")).toBe(
      false,
    );
    // Two segments apart is beyond the toolchain's historical divergence.
    expect(
      writerClaimFilesCorrespond(
        "/a/api/patterns/system/profile-home.tsx",
        HTTP_SPELLING,
      ),
    ).toBe(false);
    expect(writerClaimFilesCorrespond(undefined, HTTP_SPELLING)).toBe(false);
    expect(writerClaimFilesCorrespond(HTTP_SPELLING, undefined)).toBe(false);
  });

  it("rejects same-leaf files in unrelated directories", () => {
    expect(
      writerClaimFilesCorrespond(
        "/patterns/system/profile-home.tsx",
        "/attacker/profile-home.tsx",
      ),
    ).toBe(false);
  });
});

describe("writeAuthorizedBy across resolver spellings (labs#4772)", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    storageManager = undefined;
    runtime = undefined;
  });

  const makeRuntime = (snapshotId: string) => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
      trustSnapshotProvider: () => ({
        id: snapshotId,
        actingPrincipal: signer.did(),
      }),
    });
    return runtime;
  };

  const claimSchema = (identity: Record<string, unknown>): JSONSchema =>
    ({
      type: "object",
      properties: {
        bio: {
          type: "string",
          ifc: {
            writeAuthorizedBy: { __ctWriterIdentityOf: identity },
          },
        },
      },
      required: ["bio"],
    }) as unknown as JSONSchema;

  it("a stamped claim verifies against the same module compiled under the other spelling", async () => {
    // The cold-session bio save: claim minted+stamped by the piece-deploy
    // compile, live writer resolved via the HTTP compile. moduleIdentity
    // agrees; only the spelling differs. Before the fix the file arm
    // rejected this and the write was dropped.
    const rt = makeRuntime("ts-spelling-verify");
    const tx = rt.edit();
    const cell = rt.getCell(
      signer.did(),
      "wab-spelling-verify",
      claimSchema({
        moduleIdentity: MODULE_IDENTITY,
        file: PIECE_SPELLING,
        path: ["setBio"],
      }),
      tx,
    );
    tx.setCfcImplementationIdentity({
      kind: "verified",
      moduleIdentity: MODULE_IDENTITY,
      sourceFile: HTTP_SPELLING,
      bindingPath: ["setBio"],
    });
    cell.set({ bio: "written from the sidecar compile" });

    const digest = tx.prepareCfc();
    expect(digest).not.toBe("");
    const result = await tx.commit();
    expect(result.error).toBeUndefined();
  });

  it("an UNSTAMPED claim is stamped by the owning binding under the other spelling, then verifies", async () => {
    // The bricked-store shape: the claim persisted unstamped (seeded by a
    // foreign writer — CT-1740 leaves it unstamped on purpose) under the
    // piece spelling; the genuine bound writer arrives via the HTTP compile.
    // Rebind must recognize the correspondence, stamp, and the write commits.
    const rt = makeRuntime("ts-spelling-stamp");
    const tx = rt.edit();
    const cell = rt.getCell(
      signer.did(),
      "wab-spelling-stamp",
      claimSchema({ file: PIECE_SPELLING, path: ["setBio"] }),
      tx,
    );
    tx.setCfcImplementationIdentity({
      kind: "verified",
      moduleIdentity: MODULE_IDENTITY,
      sourceFile: HTTP_SPELLING,
      bindingPath: ["setBio"],
    });
    cell.set({ bio: "healed" });

    const digest = tx.prepareCfc();
    expect(digest).not.toBe("");
    const result = await tx.commit();
    expect(result.error).toBeUndefined();
  });

  it("a different moduleIdentity still fails closed even with corresponding spellings", async () => {
    // Cross-version rotation stays a conflict: the spelling tolerance must
    // never widen the identity arm (delegation is the setsrc-history topic).
    const rt = makeRuntime("ts-spelling-version");
    const tx = rt.edit();
    const cell = rt.getCell(
      signer.did(),
      "wab-spelling-version",
      claimSchema({
        moduleIdentity: "profile-home-module-identity-v1",
        file: PIECE_SPELLING,
        path: ["setBio"],
      }),
      tx,
    );
    tx.setCfcImplementationIdentity({
      kind: "verified",
      moduleIdentity: "profile-home-module-identity-v2",
      sourceFile: HTTP_SPELLING,
      bindingPath: ["setBio"],
    });
    cell.set({ bio: "v2 write" });

    const digest = tx.prepareCfc();
    expect(digest).toBe("");
    const result = await tx.commit();
    expect(result.error).toBeDefined();
  });

  it("an unrelated file cannot ride the tolerance to a stamp", async () => {
    // Same binding-path name in a DIFFERENT module: the file correspondence
    // rejects, the claim stays unstamped, and the unstamped claim fails
    // closed at verification.
    const rt = makeRuntime("ts-spelling-foreign");
    const tx = rt.edit();
    const cell = rt.getCell(
      signer.did(),
      "wab-spelling-foreign",
      claimSchema({ file: PIECE_SPELLING, path: ["setBio"] }),
      tx,
    );
    tx.setCfcImplementationIdentity({
      kind: "verified",
      moduleIdentity: "attacker-module-identity",
      sourceFile: "/attacker/profile-home.tsx",
      bindingPath: ["setBio"],
    });
    cell.set({ bio: "stolen" });

    const digest = tx.prepareCfc();
    expect(digest).toBe("");
    const result = await tx.commit();
    expect(result.error).toBeDefined();
  });
});

describe("stored-claim reconciliation across spellings", () => {
  const envelope = (identity: Record<string, unknown>): JSONSchemaObj =>
    ({
      type: "object",
      properties: {
        bio: {
          type: "string",
          ifc: {
            writeAuthorizedBy: { __ctWriterIdentityOf: identity },
          },
        },
      },
    }) as unknown as JSONSchemaObj;

  const claimOf = (schema: unknown): Record<string, unknown> =>
    // deno-lint-ignore no-explicit-any
    (schema as any).properties.bio.ifc.writeAuthorizedBy.__ctWriterIdentityOf;

  it("keeps the stored stamp when the candidate is the same claim under the other spelling", () => {
    const merged = mergeCfcSchemaEnvelopes(
      envelope({
        moduleIdentity: MODULE_IDENTITY,
        file: PIECE_SPELLING,
        path: ["setBio"],
      }),
      envelope({ file: HTTP_SPELLING, path: ["setBio"] }),
    );
    expect(claimOf(merged)).toEqual({
      moduleIdentity: MODULE_IDENTITY,
      file: PIECE_SPELLING,
      path: ["setBio"],
    });
  });

  it("adopts the candidate's stamp onto an unstamped stored claim across spellings", () => {
    // The self-heal direction: the store holds the unstamped claim (bricked
    // shape); a legitimately stamped input re-presents it under the other
    // spelling. The stamped side wins; the store heals.
    const merged = mergeCfcSchemaEnvelopes(
      envelope({ file: PIECE_SPELLING, path: ["setBio"] }),
      envelope({
        moduleIdentity: MODULE_IDENTITY,
        file: HTTP_SPELLING,
        path: ["setBio"],
      }),
    );
    expect(claimOf(merged)).toEqual({
      moduleIdentity: MODULE_IDENTITY,
      file: HTTP_SPELLING,
      path: ["setBio"],
    });
  });

  it("treats both-unstamped corresponding claims as the same claim (stored spelling wins)", () => {
    const merged = mergeCfcSchemaEnvelopes(
      envelope({ file: PIECE_SPELLING, path: ["setBio"] }),
      envelope({ file: HTTP_SPELLING, path: ["setBio"] }),
    );
    expect(claimOf(merged)).toEqual({
      file: PIECE_SPELLING,
      path: ["setBio"],
    });
  });

  it("still conflicts on two different stamps (no silent cross-version rotation)", () => {
    expect(() =>
      mergeCfcSchemaEnvelopes(
        envelope({
          moduleIdentity: "profile-home-module-identity-v1",
          file: PIECE_SPELLING,
          path: ["setBio"],
        }),
        envelope({
          moduleIdentity: "profile-home-module-identity-v2",
          file: HTTP_SPELLING,
          path: ["setBio"],
        }),
      )
    ).toThrow("writeAuthorizedBy must remain stable");
  });

  it("still conflicts on different binding paths", () => {
    expect(() =>
      mergeCfcSchemaEnvelopes(
        envelope({ file: PIECE_SPELLING, path: ["setBio"] }),
        envelope({ file: HTTP_SPELLING, path: ["setName"] }),
      )
    ).toThrow("writeAuthorizedBy must remain stable");
  });

  it("still conflicts on non-corresponding files", () => {
    expect(() =>
      mergeCfcSchemaEnvelopes(
        envelope({ file: "/victim.tsx", path: ["setBio"] }),
        envelope({ file: "/attacker.tsx", path: ["setBio"] }),
      )
    ).toThrow("writeAuthorizedBy must remain stable");
  });
});

describe("reportDroppedCfcRejectedWrite", () => {
  it("reports CFC-rejected drops unconditionally and stays silent otherwise", () => {
    const seen: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      seen.push(args);
    };
    try {
      reportDroppedCfcRejectedWrite(
        {
          message: "CFC enforcement rejected commit: relevant transaction " +
            "was not prepared: writeAuthorizedBy failed at /",
        },
        "handler-1",
      );
      reportDroppedCfcRejectedWrite(
        { message: "some unrelated storage conflict" },
        "handler-2",
      );
      reportDroppedCfcRejectedWrite(undefined, "handler-3");
    } finally {
      console.error = original;
    }
    expect(seen.length).toBe(1);
    expect(String(seen[0]![0])).toContain("Owner-protected write dropped");
    expect(seen[0]![1]).toMatchObject({ handlerId: "handler-1" });
  });
});
