/**
 * Unit tests for resolving a handle into the value it stands for: the
 * addresses and tokens that resolve, the rule that only a reference this run
 * holds a handle to resolves at all, the refusals for a reference that names
 * nothing readable, and the rule that no message ever renders the referent.
 */
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import { Runtime } from "@commonfabric/runner";
import { createLLMFriendlyLink } from "@commonfabric/runner/shared";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import {
  createHarnessHandleTable,
  mintAddressHandle,
} from "../src/handle-table.ts";
import {
  type HandleValueResolutionContext,
  resolveHandleValue,
} from "../src/tools/handle-values.ts";
import type { HarnessHandleTable } from "../src/contracts/handle-table.ts";

const signer = await Identity.fromPassphrase("cf-harness handle values");

const FOREIGN_REF = `/@did:key:z6MkforeignSpaceForHandleValuesTest/of:fid1:${
  "A".repeat(43)
}/`;

describe("handle-values", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pieces: PiecesController;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
    pieces = new PiecesController(
      await createSession({
        identity: signer,
        spaceName: `handle-values-${crypto.randomUUID()}`,
      }),
      runtime,
    );
    await pieces.synced();
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  const context = (
    handleTable?: HarnessHandleTable,
  ): HandleValueResolutionContext => ({
    getFabricSession: () => Promise.resolve({ pieces }),
    ...(handleTable !== undefined ? { handleTable } : {}),
  });

  /**
   * A table holding a handle to `ref`, which is what makes the reference one
   * the run may resolve. Every address a run was given arrives this way; an
   * address that did not is one the model composed.
   */
  const tableHolding = async (ref: string): Promise<HarnessHandleTable> =>
    (await mintAddressHandle(
      createHarnessHandleTable("handle-values-run"),
      ref,
    ))
      .table;

  /** An address in the run's space holding `value`, or holding nothing. */
  const seedRef = async (cause: string, value?: unknown): Promise<string> => {
    const space = pieces.getSpace();
    const cell = runtime.getCell(space, cause, {} as const);
    if (value !== undefined) {
      const { error } = await runtime.editWithRetry((tx) => {
        cell.withTx(tx).set(value);
      });
      expect(error).toBeUndefined();
      await runtime.idle();
    }
    return createLLMFriendlyLink(cell.getAsNormalizedFullLink(), space);
  };

  describe("resolveHandleValue", () => {
    it("returns the string behind an address this run holds a handle to", async () => {
      const ref = await seedRef("traveller-name", "Ada Lovelace");
      const resolution = await resolveHandleValue(
        context(await tableHolding(ref)),
        ref,
        "browser valueHandle",
      );
      expect(resolution.error).toBeUndefined();
      expect(resolution.value).toBe("Ada Lovelace");
    });

    it("returns the string behind an unswapped handle token", async () => {
      const ref = await seedRef("token-spelling", "Ada Lovelace");
      const minted = await mintAddressHandle(
        createHarnessHandleTable("handle-values-run"),
        ref,
      );
      const token = minted.token;
      const resolution = await resolveHandleValue(
        { ...context(), handleTable: minted.table },
        token,
        "browser valueHandle",
      );
      expect(resolution.value).toBe("Ada Lovelace");
    });

    it("returns an error for a token the run's handle table does not hold", async () => {
      const resolution = await resolveHandleValue(
        context(),
        "cfh:a:22222",
        "browser valueHandle",
      );
      expect(resolution.value).toBeUndefined();
      expect(resolution.error).toBe(
        "browser valueHandle does not name a handle this run holds",
      );
    });

    it("returns an error naming the field when the run has no fabric session", async () => {
      const resolution = await resolveHandleValue(
        {},
        await seedRef("no-session", "Ada Lovelace"),
        "browser urlHandle",
      );
      expect(resolution.value).toBeUndefined();
      expect(resolution.error).toContain("browser urlHandle");
      expect(resolution.error).toContain("fabric session");
    });

    it("returns an error for a reference that does not parse as an address", async () => {
      const resolution = await resolveHandleValue(
        context(),
        "the traveller's name",
        "browser valueHandle",
      );
      expect(resolution.error).toBe(
        "browser valueHandle does not name a reference this run holds",
      );
    });

    it("refuses a same-space address this run holds no handle to", async () => {
      // The inbound swap has already turned tokens into addresses by the time
      // a tool runs, so an address the model typed is indistinguishable from
      // an expanded token except by the table. Reading this one would be a
      // read of any cell in the space.
      const held = await seedRef("held-value", "Ada Lovelace");
      const unheld = await seedRef("another-users-value", "hunter2");
      const resolution = await resolveHandleValue(
        context(await tableHolding(held)),
        unheld,
        "browser valueHandle",
      );
      expect(resolution.value).toBeUndefined();
      expect(resolution.error).toBe(
        "browser valueHandle does not name a handle this run holds",
      );
    });

    it("refuses an address when the run has no handle table at all", async () => {
      const ref = await seedRef("traveller-name", "Ada Lovelace");
      const resolution = await resolveHandleValue(
        context(),
        ref,
        "browser valueHandle",
      );
      expect(resolution.error).toBe(
        "browser valueHandle does not name a handle this run holds",
      );
    });

    it("returns an error for an address in another space", async () => {
      const resolution = await resolveHandleValue(
        context(await tableHolding(FOREIGN_REF)),
        FOREIGN_REF,
        "browser valueHandle",
      );
      expect(resolution.error).toBe(
        "browser valueHandle can only read a reference in this run's own space",
      );
    });

    it("returns an error for an empty handle", async () => {
      const resolution = await resolveHandleValue(
        context(),
        "   ",
        "browser valueHandle",
      );
      expect(resolution.error).toBe(
        "browser valueHandle requires a handle naming a value",
      );
    });

    it("returns an error for an address that holds nothing", async () => {
      const ref = await seedRef("never-written");
      const resolution = await resolveHandleValue(
        context(await tableHolding(ref)),
        ref,
        "browser valueHandle",
      );
      expect(resolution.value).toBeUndefined();
      expect(resolution.error).toBe(
        "browser valueHandle names an address that holds nothing",
      );
    });

    it("returns an error naming the type, not the value, for a non-string referent", async () => {
      const ref = await seedRef("structured-value", { account: "12345678" });
      const resolution = await resolveHandleValue(
        context(await tableHolding(ref)),
        ref,
        "browser valueHandle",
      );
      expect(resolution.value).toBeUndefined();
      expect(resolution.error).toBe(
        "browser valueHandle must name a string value; the reference holds a value of type object",
      );
      // A coerced rendering would be the value by another name.
      expect(resolution.error).not.toContain("12345678");
    });

    it("returns an error naming the type, not the value, for a numeric referent", async () => {
      const ref = await seedRef("numeric-value", 12345678);
      const resolution = await resolveHandleValue(
        context(await tableHolding(ref)),
        ref,
        "browser valueHandle",
      );
      expect(resolution.error).toContain("a value of type number");
      expect(resolution.error).not.toContain("12345678");
    });
  });
});
