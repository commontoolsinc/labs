import { assert } from "@std/assert";
import { describe, it } from "@std/testing/bdd";

import { realmFromFabricValue } from "@commonfabric/data-model/codecs";
import { Identity } from "@commonfabric/identity";

import { isWorkerIPCRequest } from "../src/worker-ipc.ts";

describe("isWorkerIPCRequest", () => {
  it("validates cleanup messages", () => {
    assert(isWorkerIPCRequest({ msgId: 1, type: "cleanup" }));
    assert(isWorkerIPCRequest({ msgId: 1, type: "cleanup", data: {} }));
    assert(!isWorkerIPCRequest({ type: "cleanup" }));
  });
  it("validates initialize messages", async () => {
    const did = "did:key:abc";
    const toolshedUrl = "http://localhost:8000";
    const encodedIdentity = realmFromFabricValue(
      (await Identity.generate({ implementation: "noble" })).keyPair,
    );
    assert(
      isWorkerIPCRequest({
        msgId: 1,
        type: "initialize",
        data: { did, toolshedUrl, encodedIdentity },
      }),
    );
    assert(!isWorkerIPCRequest({ msgId: 1, type: "initialize" }));
    assert(
      !isWorkerIPCRequest({
        type: "initialize",
        data: { did, toolshedUrl, encodedIdentity },
      }),
    );
    assert(
      !isWorkerIPCRequest({
        msgId: 1,
        type: "initialize",
        data: { did, toolshedUrl },
      }),
    );
    assert(
      !isWorkerIPCRequest({
        msgId: 1,
        type: "initialize",
        data: { toolshedUrl, encodedIdentity },
      }),
    );
    assert(
      !isWorkerIPCRequest({
        msgId: 1,
        type: "initialize",
        data: { encodedIdentity, did },
      }),
    );
  });
  it("validates run messages", () => {
    const pieceId = "abc";
    assert(isWorkerIPCRequest({ msgId: 1, type: "run", data: { pieceId } }));
    assert(!isWorkerIPCRequest({ type: "run", data: { pieceId } }));
    assert(!isWorkerIPCRequest({ msgId: 1, type: "run" }));
  });
});
