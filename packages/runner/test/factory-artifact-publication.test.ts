import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { createFactoryShell } from "@commonfabric/data-model/fabric-factory";
import type { FabricValue } from "@commonfabric/data-model/fabric-value";
import { Identity } from "@commonfabric/identity";

import { getMetaCell } from "../src/link-utils.ts";
import { sendValueToBinding } from "../src/pattern-binding.ts";
import { createQueryResultProxy } from "../src/query-result-proxy.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase(
  "factory artifact publication test",
);
const destinationSpace = signer.did();
const REF = {
  identity: "PAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  symbol: "publicationFactory",
} as const;
const unavailableFactory = createFactoryShell({
  kind: "module",
  ref: REF,
  argumentSchema: true,
  resultSchema: true,
}) as FabricValue;

describe("Factory@1 artifact publication fences", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
    runtime.patternManager.isArtifactAvailableInSpace = () => false;
  });

  afterEach(async () => {
    if (tx.status().status === "ready") {
      tx.abort(new Error("test cleanup"));
    }
    await runtime.dispose();
    await storageManager.close();
  });

  function expectedUnavailableMessage(): string {
    return `Factory artifact ${REF.identity} is not available in space ${destinationSpace}`;
  }

  it("rejects an unavailable factory before a normal output binding write", () => {
    const resultCell = runtime.getCell<{ factory?: FabricValue }>(
      destinationSpace,
      "unavailable factory output binding",
      undefined,
      tx,
    );
    const argumentCellLink = getMetaCell(resultCell, "argument", tx)
      .getAsNormalizedFullLink();

    expect(() =>
      sendValueToBinding(
        tx,
        resultCell,
        argumentCellLink,
        { $alias: { cell: "result", path: ["factory"] } },
        unavailableFactory,
      )
    ).toThrow(expectedUnavailableMessage());
    expect(resultCell.key("factory").getRaw()).toBeUndefined();
  });

  it("rejects an unavailable factory before a writable query-result write", () => {
    const destination = runtime.getCell<{ factory?: FabricValue }>(
      destinationSpace,
      "unavailable factory query result",
      undefined,
      tx,
    );
    destination.set({});
    const writable = createQueryResultProxy<{ factory?: FabricValue }>(
      runtime,
      tx,
      destination.getAsNormalizedFullLink(),
      0,
      true,
    );

    expect(() => {
      writable.factory = unavailableFactory;
    }).toThrow(expectedUnavailableMessage());
    expect(destination.key("factory").getRaw()).toBeUndefined();
  });
});
