import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { fromFileUrl } from "@std/path";

import { cfcLabelViewForCell } from "../src/cfc/mod.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";

const signer = await Identity.fromPassphrase(
  "profile-home-verified-identities",
);
const space = signer.did();
const sysDir = fromFileUrl(new URL("../../patterns/system/", import.meta.url));
const PROGRAM: RuntimeProgram = {
  main: "/profile-home.tsx",
  files: [{
    name: "/profile-home.tsx",
    contents: Deno.readTextFileSync(sysDir + "profile-home.tsx"),
  }],
};
const INTEGRITY = "loom-verified-external-identity";

function integrityAtoms(cell: unknown): unknown[] {
  return (cfcLabelViewForCell(cell)?.entries ?? []).flatMap(
    (entry) => entry.label.integrity ?? [],
  );
}

describe("profile-home verified external identities", () => {
  let manager: EmulatedStorageManager;

  beforeEach(() => {
    manager = EmulatedStorageManager.emulate({ as: signer });
  });
  afterEach(async () => {
    await manager?.close();
  });

  it("persists one integrity label over type, value, and verifiedAt", async () => {
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
    });
    try {
      const tx = runtime.edit();
      const pattern = await runtime.patternManager.compilePattern(PROGRAM, {
        space,
        tx,
      });
      const resultCell = runtime.getCell<Record<string, unknown>>(
        space,
        "profile-home verified identity",
        undefined,
        tx,
      );
      // deno-lint-ignore no-explicit-any
      const result = runtime.run(tx, pattern as any, {
        initialName: "Ada Lovelace",
      }, resultCell);
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();
      await result.pull();

      const publishTx = runtime.edit();
      result.withTx(publishTx).key("publishVerifiedIdentities").send({
        identities: [{
          type: "github.login",
          value: "ada",
          verifiedAt: "2026-07-15T20:00:00Z",
        }],
      });
      expect((await publishTx.commit()).error).toBeUndefined();
      await runtime.idle();
      await result.pull();

      const item = result.key("verifiedIdentities").key(0);
      expect(await item.pull()).toEqual({
        type: "github.login",
        value: "ada",
        verifiedAt: "2026-07-15T20:00:00.000Z",
      });
      for (const field of ["type", "value", "verifiedAt"]) {
        expect(integrityAtoms(item.key(field))).toContain(INTEGRITY);
      }

      const revokeTx = runtime.edit();
      result.withTx(revokeTx).key("revokeVerifiedIdentities").send({
        identities: [{ type: "github.login", value: "ada" }],
      });
      expect((await revokeTx.commit()).error).toBeUndefined();
      await runtime.idle();
      await result.pull();
      expect(result.key("verifiedIdentities").get()).toEqual([]);
    } finally {
      await runtime.dispose();
    }
  });
});
