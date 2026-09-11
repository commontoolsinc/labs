import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";

import { Identity } from "@commonfabric/identity";
import type { SessionViewInterest } from "@commonfabric/memory/v2";

import { COMPONENT_READ_CONTRACT_VERSION } from "../src/component-read-contract.ts";
import { ViewPlanPublisher } from "../src/executor/view-plan-publisher.ts";
import { toMemorySpaceAddress } from "../src/link-utils.ts";
import { rendererVDOMSchema } from "../src/schemas.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import type { ViewExecutionNode } from "../src/view-replication.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("view plan invalidation");
const space = signer.did();

describe("view plan publisher", () => {
  let fixture: Awaited<ReturnType<typeof setup>>;

  async function setup() {
    const server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: EmulatedStorageManager.connectTo(server, { as: signer }),
    });
    const root = runtime.getCell(space, "view", undefined);
    const output = runtime.getCell<number>(space, "output", { type: "number" });
    const input = runtime.getCell<number>(space, "input", { type: "number" });
    const hidden = runtime.getCell<number>(space, "hidden", { type: "number" });
    await runtime.editWithRetry((tx) => {
      input.withTx(tx).set(1);
      output.withTx(tx).set(2);
      hidden.withTx(tx).set(3);
      root.withTx(tx).set({
        $UI: { type: "vnode", name: "div", props: {}, children: [output] },
      });
    });
    await runtime.storageManager.synced();
    const interest: SessionViewInterest = {
      handle: {
        sessionId: "viewer",
        sessionEpoch: "session",
        viewEpoch: "view",
        viewId: "screen",
        revision: 0,
      },
      principal: signer.did(),
      attached: true,
      view: {
        id: "screen",
        revision: 0,
        mode: "speculate",
        componentContractVersion: COMPONENT_READ_CONTRACT_VERSION,
        query: {
          roots: [{
            id: root.getAsNormalizedFullLink().id,
            selector: { path: [] },
          }],
        },
      },
    };
    const nodes: ViewExecutionNode[] = [{
      id: "producer",
      kind: "computation",
      current: true,
      piece: root.getAsNormalizedFullLink(),
      writes: [toMemorySpaceAddress(output.getAsNormalizedFullLink())],
      log: {
        reads: [toMemorySpaceAddress(input.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(output.getAsNormalizedFullLink())],
      },
    }];
    const interests = stub(server, "viewInterestsForSpace", () => [interest]);
    const observations = stub(
      runtime.scheduler,
      "viewExecutionNodes",
      () => nodes,
    );
    const publications = stub(
      server,
      "setViewSelection",
      () => Promise.resolve(true),
    );
    const reads = spy(runtime, "readTx");
    const links = spy(runtime, "getCellFromLink");
    return {
      server,
      runtime,
      root,
      output,
      input,
      hidden,
      interest,
      nodes,
      interests,
      observations,
      publications,
      reads,
      links,
      publisher: new ViewPlanPublisher(),
    };
  }

  beforeEach(async () => {
    fixture = await setup();
  });
  afterEach(async () => {
    fixture.publisher.dispose();
    fixture.reads.restore();
    fixture.links.restore();
    fixture.publications.restore();
    fixture.observations.restore();
    fixture.interests.restore();
    await fixture.runtime.storageManager.synced();
    await fixture.runtime.dispose();
    await fixture.server.close();
  });

  const publish = () =>
    fixture.publisher.publish(fixture.runtime, fixture.server, space);

  it("reuses the UI walk and certificates across quiet cycles and unrelated writes", async () => {
    await publish();
    const initialReads = fixture.reads.calls.length;
    expect(initialReads).toBeGreaterThan(0);
    await publish();
    expect(fixture.reads.calls).toHaveLength(initialReads);
    await fixture.runtime.editWithRetry((tx) =>
      fixture.hidden.withTx(tx).set(4)
    );
    const before = fixture.reads.calls.length;
    await publish();
    expect(fixture.reads.calls).toHaveLength(before);
    expect(fixture.publications.calls).toHaveLength(1);
  });

  it("refreshes producer currency without repeating the UI walk", async () => {
    await publish();
    expect(fixture.publications.calls.at(-1)!.args[2].producers?.[0].basis)
      .toBeDefined();
    fixture.nodes[0].current = false;
    const before = fixture.reads.calls.length;
    await publish();
    expect(fixture.reads.calls.length - before).toBe(1);
    expect(fixture.publications.calls.at(-1)!.args[2].producers?.[0].basis)
      .toBeUndefined();
  });

  it("refreshes fingerprints for upstream input changes while retaining the UI walk", async () => {
    await publish();
    const previous = fixture.publications.calls.at(-1)!.args[2].producers?.[0]
      .basis;
    await fixture.runtime.editWithRetry((tx) =>
      fixture.input.withTx(tx).set(5)
    );
    const before = fixture.reads.calls.length;
    await publish();
    expect(fixture.reads.calls.length - before).toBe(1);
    expect(fixture.publications.calls.at(-1)!.args[2].producers?.[0].basis).not
      .toEqual(previous);
  });

  it("incorporates a handler's new observations without repeating the UI walk", async () => {
    const stream = fixture.runtime.getCell(space, "click", undefined);
    await fixture.runtime.editWithRetry((tx) => {
      stream.withTx(tx).set({ $stream: true });
      fixture.root.withTx(tx).set({
        $UI: {
          type: "vnode",
          name: "button",
          props: { onClick: stream },
          children: [fixture.output],
        },
      });
    });
    await fixture.runtime.storageManager.synced();
    await publish();
    fixture.nodes.push({
      id: "click-handler",
      kind: "handler",
      piece: fixture.root.getAsNormalizedFullLink(),
      stream: stream.getAsNormalizedFullLink(),
      writes: [toMemorySpaceAddress(fixture.input.getAsNormalizedFullLink())],
      log: {
        reads: [toMemorySpaceAddress(fixture.hidden.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [],
      },
    });
    const before = fixture.links.calls.length;
    await publish();
    expect(
      fixture.links.calls.slice(before).filter((call) =>
        call.args[1] === rendererVDOMSchema
      ),
    ).toHaveLength(0);
    const selection = fixture.publications.calls.at(-1)!.args[2];
    expect(selection.eligibleActions).toContain("click-handler");
    expect(selection.eligibleActions).toContain("producer");
    expect(selection.inputs?.map((input) => input.id)).toContain(
      fixture.hidden.getAsNormalizedFullLink().id,
    );
    fixture.nodes[1].log = { reads: [], shallowReads: [], writes: [] };
    await publish();
    expect(
      fixture.links.calls.slice(before).filter((call) =>
        call.args[1] === rendererVDOMSchema
      ),
    ).toHaveLength(0);
    expect(
      fixture.publications.calls.at(-1)!.args[2].inputs?.map((input) =>
        input.id
      ),
    )
      .not.toContain(fixture.hidden.getAsNormalizedFullLink().id);
  });

  it("retains invalidations received during publication and while disconnected", async () => {
    fixture.publications.restore();
    fixture.publications = stub(
      fixture.server,
      "setViewSelection",
      async () => {
        await fixture.runtime.editWithRetry((tx) =>
          fixture.input.withTx(tx).set(7)
        );
        return true;
      },
    );
    await publish();
    const previous = fixture.publications.calls.at(-1)!.args[2].producers?.[0]
      .basis;
    fixture.interest.attached = false;
    const before = fixture.reads.calls.length;
    await publish();
    expect(fixture.reads.calls).toHaveLength(before);
    fixture.interest.attached = true;
    await publish();
    expect(fixture.publications.calls).toHaveLength(2);
    expect(fixture.publications.calls.at(-1)!.args[2].producers?.[0].basis).not
      .toEqual(previous);
  });

  it("does not cache a selection the memory server rejected", async () => {
    fixture.publications.restore();
    let accepted = false;
    fixture.publications = stub(
      fixture.server,
      "setViewSelection",
      () => Promise.resolve(accepted),
    );
    await publish();
    accepted = true;
    await publish();
    expect(fixture.publications.calls).toHaveLength(2);
    await publish();
    expect(fixture.publications.calls).toHaveLength(2);
  });

  it("re-walks changed visible values and new view lifetimes", async () => {
    await publish();
    await fixture.runtime.editWithRetry((tx) =>
      fixture.output.withTx(tx).set(6)
    );
    const before = fixture.reads.calls.length;
    await publish();
    expect(fixture.reads.calls.length - before).toBeGreaterThan(1);
    fixture.interest.handle = {
      ...fixture.interest.handle,
      viewEpoch: "replacement",
    };
    const replaced = fixture.reads.calls.length;
    await publish();
    expect(fixture.reads.calls.length - replaced).toBeGreaterThan(1);
    expect(fixture.publications.calls).toHaveLength(3);
  });
});
