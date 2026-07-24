import { assertEquals } from "@std/assert";
import type { MemorySpace } from "@commonfabric/memory/interface";
import {
  type ExecutionClaim,
  type ExecutionControlEvent,
  resetServerPrimaryExecutionConfig,
  type SessionSync,
  setServerPrimaryExecutionConfig,
} from "@commonfabric/memory/v2";
import * as MemoryClient from "@commonfabric/memory/v2/client";
import { Server } from "@commonfabric/memory/v2/server";
import {
  createHostProviderChannel,
  HostStorageManager,
} from "../src/storage/v2-host-provider.ts";

const SPACE = "did:key:z6Mk-host-execution-control" as MemorySpace;
const FLAGS = {
  serverPrimaryExecutionV1: true,
  serverPrimaryExecutionClaimRoutingV1: true,
  serverPrimaryExecutionBuiltinPassivityV1: true,
} as const;

const claim = (actionId: string): ExecutionClaim => ({
  branch: "",
  space: SPACE,
  contextKey: "space",
  pieceId: "space:of:host-execution-control-piece",
  actionId,
  actionKind: "computation",
  implementationFingerprint: `impl:${actionId}`,
  runtimeFingerprint: "runtime:host-execution-control",
  leaseGeneration: 1,
  claimGeneration: 1,
  expiresAt: 100_000,
});

Deno.test("hosted client preserves execution batch and subscription lifecycles", async () => {
  setServerPrimaryExecutionConfig(true);
  const first = claim("action:first");
  const second = claim("action:second");
  const events: ExecutionControlEvent[] = [{
    type: "session.execution.claim.set",
    claim: first,
  }, {
    type: "session.execution.claim.set",
    claim: second,
  }];
  const originalSubscribe = MemoryClient.SpaceSession.prototype
    .subscribeExecutionControl;
  const originalApplySync = MemoryClient.WatchView.prototype.applySync;
  let activeSubscriptions = 0;
  let injected = false;
  const delivered: NonNullable<SessionSync["execution"]>[] = [];

  MemoryClient.SpaceSession.prototype.subscribeExecutionControl = function (
    listener,
  ) {
    activeSubscriptions++;
    const unsubscribe = originalSubscribe.call(this, listener);
    let active = true;
    if (!injected) {
      injected = true;
      for (const event of events) listener(event);
    }
    return () => {
      if (!active) return;
      active = false;
      activeSubscriptions--;
      unsubscribe();
    };
  };
  MemoryClient.WatchView.prototype.applySync = function (sync, emit) {
    if (sync.execution !== undefined) delivered.push(sync.execution);
    originalApplySync.call(this, sync, emit);
  };

  const server = new Server({
    authorizeSessionOpen: () => SPACE,
    sessionOpenAuth: { audience: SPACE },
    protocolFlags: FLAGS,
  });
  const channel = createHostProviderChannel({
    server,
    space: SPACE,
    allowExecutionDemand: true,
    authorizeSessionOpen: (_space, _session, context) => ({
      invocation: {
        aud: context.audience,
        challenge: context.challenge.value,
      },
      authorization: { principal: SPACE },
    }),
  });
  const storage = HostStorageManager.connect({
    port: channel.port,
    principal: SPACE,
    space: SPACE,
    protocolFlags: FLAGS,
    supportsExecutionDemand: true,
  });

  try {
    assertEquals(
      (await storage.open(SPACE).sync("of:host-execution-control-root")).error,
      undefined,
    );
    await storage.synced();

    assertEquals(activeSubscriptions, 1);
    assertEquals(delivered, [{
      fromFeedSeq: 1,
      toFeedSeq: 2,
      events,
    }]);

    await storage.close();
    assertEquals(activeSubscriptions, 0);
  } finally {
    MemoryClient.SpaceSession.prototype.subscribeExecutionControl =
      originalSubscribe;
    MemoryClient.WatchView.prototype.applySync = originalApplySync;
    await storage.close();
    await channel.dispose();
    await server.close();
    resetServerPrimaryExecutionConfig();
  }
});
