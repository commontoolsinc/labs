/**
 * The serving loop's worker entry (serving-loop-worker.md). Loading this
 * module in a Worker installs the port's endpoint on the worker's global scope
 * and waits for the `worker.init` request, which carries the service key and
 * the host's options; it then builds the `ExecutorHost` over a `ServingPlane`
 * and answers once the host serves. Nothing outside a worker imports a value
 * from here; `serving-worker-host.ts` starts one.
 */

import { Identity, keyPairFromRealmValue } from "@commonfabric/identity";
import { adoptProcessInstanceId } from "@commonfabric/memory/v2/execution-lease";
import { holdWorkerLifetimeLock } from "@commonfabric/utils/worker-lifetime";
import { ExecutorHost } from "./host.ts";
import { ServingPlane, servingPlaneEndpoint } from "./serving-port-plane.ts";
import type { PortLike } from "./serving-port-protocol.ts";
import { servingRuntimeFactory } from "./serving-runtime.ts";

const endpoint = servingPlaneEndpoint(self as unknown as PortLike);

endpoint.onRequest("worker.init", async (init) => {
  adoptProcessInstanceId(init.processInstanceId);
  const identity = await Identity.fromKeyPair(
    keyPairFromRealmValue(init.serviceKeyPair, "the serving worker's key"),
  );
  const plane = new ServingPlane(endpoint);
  const host = new ExecutorHost({
    server: plane.server,
    serviceIdentity: identity.did(),
    createRuntime: servingRuntimeFactory({
      server: plane.loopback,
      identity,
      apiUrl: new URL(init.apiUrl),
      ...(init.experimental === undefined
        ? {}
        : { experimental: init.experimental }),
    }),
    ...(init.policy === undefined ? {} : { policy: init.policy }),
    ...(init.ensureSpaceRoots === undefined
      ? {}
      : { ensureSpaceRoots: init.ensureSpaceRoots }),
    createWaveCommitSink: (deps) => plane.createWaveCommitSink(deps),
    // The counters cross on the loop's own edges: every wave cycle, and
    // each tenure's start and end.
    onWaveCycle: () => plane.reportStats(host.stats()),
    onActivationSettled: (space, outcome) => {
      plane.reportActivationSettled(space, outcome);
      plane.reportStats(host.stats());
    },
    onSpaceParked: (space, reason) => {
      plane.reportSpaceParked(space, reason);
      plane.reportStats(host.stats());
    },
  });
  plane.serve({
    stats: () => host.stats(),
    runLifecycleVerb: (space, verb) =>
      Promise.reject(
        new Error(
          `the serving worker has no builder for the lifecycle verb ` +
            `"${verb.name}" on ${space}`,
        ),
      ),
    close: async () => {
      try {
        await host.close();
      } finally {
        await plane.close();
      }
    },
  });
  return { lifetimeLock: await holdWorkerLifetimeLock() };
});

endpoint.notify("worker.ready", null);
