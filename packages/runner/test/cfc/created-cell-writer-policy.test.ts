import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { Cell } from "../../src/cell.ts";
import { loadStoredCfcEnvelope } from "../../src/cfc/prepare.ts";
import type { RuntimeProgram } from "../../src/harness/types.ts";
import { Runtime } from "../../src/runtime.ts";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";
import type {
  RuntimeTelemetryEvent,
  RuntimeTelemetryMarker,
} from "../../src/telemetry.ts";
import { newSharedServer } from "../memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("created-cell-writer-policy");
const space = signer.did();

// `f` is the declared writer of every protected cell; `g` has the same
// unlabeled state type and is named by none. Each cell is created with
// `undefined`, as the agent queue's `agentRunner` is, except `init`, which is
// created with a value.
const program: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: `import {
  Cfc, CurrentPrincipal, handler, pattern, RepresentsCurrentUser, Stream,
  Writable, WriteAuthorizedBy,
} from "commonfabric";
type Entry = { host: string };
const f = handler<string, { value: Writable<Entry | undefined> }>((event, { value }) => value.set({ host: event }));
const g = handler<string, { value: Writable<Entry | undefined> }>((event, { value }) => value.set({ host: event }));
type Protected = WriteAuthorizedBy<Entry, typeof f>;
type Owned = RepresentsCurrentUser<Cfc<WriteAuthorizedBy<Entry, typeof f>, { ownerPrincipal: CurrentPrincipal }>>;
export default pattern<{}, {
  undef: Protected; init: Protected; owned: Owned;
  fUndef: Stream<string>; gUndef: Stream<string>;
  fInit: Stream<string>; gInit: Stream<string>;
  fOwned: Stream<string>;
}>(() => {
  const undef = new Writable<Protected | undefined>(undefined).for("undef");
  const init = new Writable<Protected | undefined>({ host: "initial" }).for("init");
  const owned = new Writable<Owned | undefined>(undefined).for("owned");
  return {
    undef: undef as any, init: init as any, owned: owned as any,
    fUndef: f({ value: undef as any }), gUndef: g({ value: undef as any }),
    fInit: f({ value: init as any }), gInit: g({ value: init as any }),
    fOwned: f({ value: owned as any }),
  };
});`,
  }],
};

describe("created cell writer policy", () => {
  let server: MemoryV2Server.Server;
  let manager: EmulatedStorageManager;
  let runtime: Runtime;
  let result: Cell<unknown>;

  /**
   * Sets the program up. A setup is the acting principal's act unless
   * `attributeInitialization` is `false`.
   */
  const setUp = async (attributeInitialization?: false) => {
    const setup = runtime.edit();
    const compiled = await runtime.patternManager.compilePattern(program, {
      space,
      tx: setup,
    });
    result = runtime.run(
      setup,
      compiled,
      {},
      runtime.getCell(space, "created-cell-writer-policy", undefined, setup),
      attributeInitialization === false ? { attributeInitialization } : {},
    );
    runtime.prepareTxForCommit(setup);
    expect((await setup.commit().settled).error).toBeUndefined();
    await result.pull();
    await runtime.idle();
  };

  beforeEach(() => {
    server = newSharedServer();
    manager = EmulatedStorageManager.connectTo(server, { as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await manager?.close();
    await server?.close();
  });

  const host = (key: string) =>
    (result.key(key as never).get() as { host?: string } | undefined)?.host;

  const stored = (key: string) => {
    const link = result.key(key as never).resolveAsCell()
      .getAsNormalizedFullLink();
    return loadStoredCfcEnvelope(runtime.readTx(), {
      space: link.space,
      id: link.id,
      scope: link.scope,
    });
  };

  /** The principals the cell's stored label says it represents. */
  const representedBy = (key: string): string[] => {
    const envelope = stored(key);
    if (envelope.status !== "loaded") return [];
    return envelope.metadata.labelMap.entries
      .flatMap((entry) => entry.label.integrity ?? [])
      .filter((atom) =>
        (atom as { kind?: string }).kind === "represents-principal"
      )
      .map((atom) => (atom as { subject: unknown }).subject as string)
      .sort();
  };

  /** Sends `value` on `stream`, resolving with each event commit's error, or "ok". */
  const send = async (stream: string, value: string) => {
    const commits: Extract<
      RuntimeTelemetryMarker,
      { type: "scheduler.event.commit" }
    >[] = [];
    const listener = (event: Event) => {
      const marker = (event as RuntimeTelemetryEvent).detail.marker;
      if (marker.type === "scheduler.event.commit") commits.push(marker);
    };
    runtime.telemetry.addEventListener("telemetry", listener);
    try {
      await runtime.editWithRetry((tx) => {
        result.withTx(tx).key(stream).send(value as never);
      });
      await runtime.scheduler.idleWithPendingCommits();
      await runtime.idle();
      await result.pull();
      return commits.map((commit) => commit.error ?? "ok");
    } finally {
      runtime.telemetry.removeEventListener("telemetry", listener);
    }
  };

  describe("on a cell created with undefined", () => {
    it("stores the declared writer policy at setup", async () => {
      await setUp();

      const envelope = stored("undef");
      expect(envelope.status).toBe("loaded");
      expect(JSON.stringify(envelope.status === "loaded" && envelope.schema))
        .toContain('"writeAuthorizedBy"');
      expect(host("undef")).toBeUndefined();
    });

    it("refuses a write by a handler the policy does not name", async () => {
      await setUp();

      const outcomes = await send("gUndef", "g");

      expect(outcomes).toHaveLength(1);
      expect(String(outcomes[0])).toContain("writeAuthorizedBy");
      expect(host("undef")).toBeUndefined();
    });

    it("admits the declared writer's first write", async () => {
      await setUp();

      expect(await send("fUndef", "f")).toEqual(["ok"]);
      expect(host("undef")).toBe("f");
      expect(String((await send("gUndef", "g"))[0])).toContain(
        "writeAuthorizedBy",
      );
      expect(host("undef")).toBe("f");
    });

    it("binds no owner in a setup that is nobody's act, and binds the declared writer's first writer", async () => {
      await setUp(false);

      expect(stored("owned").status).toBe("loaded");
      expect(representedBy("owned")).toEqual([]);
      expect(await send("fOwned", "f")).toEqual(["ok"]);
      expect(representedBy("owned")).toEqual([signer.did()]);
    });

    it("binds the acting principal as owner in a setup that is their act", async () => {
      await setUp();

      expect(representedBy("owned")).toEqual([signer.did()]);
    });
  });

  describe("on a cell created with a value", () => {
    it("stores the declared writer policy at setup, and refuses a handler the policy does not name", async () => {
      await setUp();

      expect(stored("init").status).toBe("loaded");
      expect(String((await send("gInit", "g"))[0])).toContain(
        "writeAuthorizedBy",
      );
      expect(host("init")).toBe("initial");
    });
  });
});
