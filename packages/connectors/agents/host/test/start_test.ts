import type { AgentFabricRuntime } from "../src/fabric-runtime.ts";
import type { AgentsHost } from "../src/host.ts";
import type { AgentsHostProcessLock } from "../src/process-lock.ts";
import { RunningAgentsHost } from "../src/start.ts";
import { assertEquals } from "@std/assert";

Deno.test("RunningAgentsHost settles runtime work before disposal", async () => {
  const events: string[] = [];
  const host = {
    stop: () => {
      events.push("host.stop");
      return Promise.resolve();
    },
  } as unknown as AgentsHost;
  const fabric = {
    runtime: {
      settled: (rounds?: number) => {
        events.push(`runtime.settled:${rounds}`);
        return Promise.resolve();
      },
      storageManager: {
        synced: () => {
          events.push("storage.synced");
          return Promise.resolve();
        },
      },
      dispose: () => {
        events.push("runtime.dispose");
        return Promise.resolve();
      },
    },
    spaceDid: "did:key:test",
  } as unknown as AgentFabricRuntime;
  const processLocks = [{
    release: () => {
      events.push("lock.release");
      return Promise.resolve();
    },
  }] as unknown as AgentsHostProcessLock[];
  const running = new RunningAgentsHost({
    host,
    fabric,
    initialSessionCount: 0,
    ledgerPath: "/tmp/agents-host-test-ledger",
    processLocks,
  });

  await running.stop();

  assertEquals(events, [
    "host.stop",
    "runtime.settled:Infinity",
    "storage.synced",
    "runtime.dispose",
    "lock.release",
  ]);
});
