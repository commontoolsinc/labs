import { describe, it } from "@std/testing/bdd";
import { assert } from "@std/assert";
import { isWorkerIPCRequest } from "../src/worker-ipc.ts";
import { Identity } from "@commontools/identity";

describe("isWorkerIPCRequest", () => {
  it("validates cleanup messages", () => {
    assert(isWorkerIPCRequest({ msgId: 1, type: "cleanup" }));
    assert(!isWorkerIPCRequest({ type: "cleanup" }));
    assert(!isWorkerIPCRequest({ msgId: 1, type: "cleanup", data: {} }));
  });
  it("validates initialize messages", async () => {
    const did = "did:key:abc";
    const toolshedUrl = "http://localhost:8000";
    const rawIdentity = (await Identity.generate({ implementation: "noble" }))
      .serialize();
    assert(
      isWorkerIPCRequest({
        msgId: 1,
        type: "initialize",
        data: { did, toolshedUrl, rawIdentity },
      }),
    );
    assert(!isWorkerIPCRequest({ msgId: 1, type: "initialize" }));
    assert(
      !isWorkerIPCRequest({
        type: "initialize",
        data: { did, toolshedUrl, rawIdentity },
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
        data: { toolshedUrl, rawIdentity },
      }),
    );
    assert(
      !isWorkerIPCRequest({
        msgId: 1,
        type: "initialize",
        data: { rawIdentity, did },
      }),
    );
  });
  it("validates run messages", () => {
    const charmId = "abc";
    assert(isWorkerIPCRequest({ msgId: 1, type: "run", data: { charmId } }));
    assert(!isWorkerIPCRequest({ type: "run", data: { charmId } }));
    assert(!isWorkerIPCRequest({ msgId: 1, type: "run" }));
  });
});
