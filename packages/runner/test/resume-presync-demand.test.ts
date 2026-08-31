import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import type { JSONSchema } from "@commonfabric/api";

const signer = await Identity.fromPassphrase("resume presync demand");
const space = signer.did();

describe("resume-presync-demand", () => {
  // A sync honoring a trivially-permissive schema asks the server for the
  // cell's whole reachable graph. The two sites here exist for LOCALITY —
  // having a document present before something writes or reads it — so each
  // must ask for the document, never the closure. The spy records the schema
  // every cell sync actually carries; the assertions are on what was asked,
  // which is what decides the server's walk and the wire.
  let server: ReturnType<typeof newSharedServer>;
  let sm: EmulatedStorageManager;
  let runtime: Runtime;
  let syncedSchemas: (JSONSchema | undefined)[];

  beforeEach(() => {
    server = newSharedServer();
    sm = EmulatedStorageManager.connectTo(server, { as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: sm,
    });
    syncedSchemas = [];
    const original = sm.syncCell.bind(sm);
    sm.syncCell = ((cell, options) => {
      syncedSchemas.push(cell.getAsNormalizedFullLink().schema);
      return original(cell, options);
    }) as typeof sm.syncCell;
  });

  afterEach(async () => {
    await runtime.dispose();
    await sm.close();
    await server.close();
  });

  it("kicks a document sync for a meta write, never the cell's open schema", async () => {
    const cell = runtime.getCell(space, "meta-write-target", true);
    const tx = runtime.edit();
    cell.withTx(tx).setMetaRaw("slug", "kick", rawMetaWriteAuthorization);
    tx.abort("inspection only");

    // The kick fired for the document alone: the open schema the cell
    // carries never reaches a sync.
    expect(syncedSchemas).toContain(false);
    expect(syncedSchemas).not.toContain(true);
  });

  it("kicks one document sync for repeated meta writes on one cell", async () => {
    const cell = runtime.getCell(space, "meta-write-once", true);
    const tx = runtime.edit();
    const bound = cell.withTx(tx);
    bound.setMetaRaw("slug", "first", rawMetaWriteAuthorization);
    bound.setMetaRaw("slug", "second", rawMetaWriteAuthorization);
    tx.abort("inspection only");

    expect(syncedSchemas.filter((schema) => schema === false).length).toBe(1);
  });
});
