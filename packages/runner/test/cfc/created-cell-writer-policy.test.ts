import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";

import type { Cell } from "../../src/cell.ts";
import { loadStoredCfcEnvelope } from "../../src/cfc/prepare.ts";
import type { RuntimeProgram } from "../../src/harness/types.ts";
import { Runtime } from "../../src/runtime.ts";
import { runtimePresets } from "../../src/runtime-presets.ts";
import type { IExtendedStorageTransaction } from "../../src/storage/interface.ts";
import { EmulatedStorageManager } from "../../src/storage/v2-emulate.ts";
import type {
  RuntimeTelemetryEvent,
  RuntimeTelemetryMarker,
} from "../../src/telemetry.ts";
import { newSharedServer } from "../memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("created-cell-writer-policy");
const space = signer.did();

// `f` is the declared writer of every protected cell; `g` and `h` have the
// same unlabeled state type and are named by none, `h` clearing the cell.
// Each cell is created with `undefined`, as the agent queue's `agentRunner`
// is, except `init`, which is created with a value. `nested` declares its
// policy on a field only.
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
const h = handler<string, { value: Writable<Entry | undefined> }>((_event, { value }) => value.set(undefined));
type Protected = WriteAuthorizedBy<Entry, typeof f>;
type NestedProtected = { host: WriteAuthorizedBy<string, typeof f> };
type Owned = RepresentsCurrentUser<Cfc<WriteAuthorizedBy<Entry, typeof f>, { ownerPrincipal: CurrentPrincipal }>>;
export default pattern<{}, {
  undef: Protected; init: Protected; owned: Owned; nested: NestedProtected;
  fUndef: Stream<string>; gUndef: Stream<string>; hUndef: Stream<string>;
  fNested: Stream<string>; gNested: Stream<string>;
  fInit: Stream<string>; gInit: Stream<string>;
  fOwned: Stream<string>;
}>(() => {
  const undef = new Writable<Protected | undefined>(undefined).for("undef");
  const init = new Writable<Protected | undefined>({ host: "initial" }).for("init");
  const owned = new Writable<Owned | undefined>(undefined).for("owned");
  const nested = new Writable<NestedProtected | undefined>(undefined).for("nested");
  return {
    undef: undef as any, init: init as any, owned: owned as any, nested: nested as any,
    fUndef: f({ value: undef as any }), gUndef: g({ value: undef as any }), hUndef: h({ value: undef as any }),
    fNested: f({ value: nested as any }), gNested: g({ value: nested as any }),
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

  const host = (key: string, cell = result) =>
    (cell.key(key as never).get() as { host?: string } | undefined)?.host;

  const stored = (key: string, cell = result, on = runtime) => {
    const link = cell.key(key as never).resolveAsCell()
      .getAsNormalizedFullLink();
    return loadStoredCfcEnvelope(on.readTx(), {
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
  const send = async (
    stream: string,
    value: string,
    cell = result,
    on = runtime,
  ) => {
    const commits: Extract<
      RuntimeTelemetryMarker,
      { type: "scheduler.event.commit" }
    >[] = [];
    const listener = (event: Event) => {
      const marker = (event as RuntimeTelemetryEvent).detail.marker;
      if (marker.type === "scheduler.event.commit") commits.push(marker);
    };
    on.telemetry.addEventListener("telemetry", listener);
    try {
      await on.editWithRetry((tx) => {
        cell.withTx(tx).key(stream).send(value as never);
      });
      await on.scheduler.idleWithPendingCommits();
      await on.idle();
      await cell.pull();
      return commits.map((commit) => commit.error ?? "ok");
    } finally {
      on.telemetry.removeEventListener("telemetry", listener);
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

    it("refuses a clear by a handler the policy does not name", async () => {
      await setUp();

      expect(await send("fUndef", "f")).toEqual(["ok"]);
      const outcomes = await send("hUndef", "h");

      expect(outcomes).toHaveLength(1);
      expect(String(outcomes[0])).toContain("writeAuthorizedBy");
      expect(host("undef")).toBe("f");
    });

    it("stores a policy declared on a field only, and refuses a handler it does not name", async () => {
      await setUp();

      expect(stored("nested").status).toBe("loaded");
      const outcomes = await send("gNested", "g");
      expect(outcomes).toHaveLength(1);
      expect(String(outcomes[0])).toContain("writeAuthorizedBy");
      expect(host("nested")).toBeUndefined();
      expect(await send("fNested", "f")).toEqual(["ok"]);
      expect(host("nested")).toBe("f");
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

  describe("on a per-user cell created with undefined", () => {
    // Each user's instance of the cell is seeded where that user's runtime
    // starts the piece, as well as at setup.
    const scopedProgram: RuntimeProgram = {
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents:
          `import { handler, pattern, PerUser, Stream, Writable, WriteAuthorizedBy } from "commonfabric";
type Entry = { host: string };
const f = handler<string, { value: Writable<Entry | undefined> }>((event, { value }) => value.set(event === "" ? undefined : { host: event }));
const g = handler<string, { value: Writable<Entry | undefined> }>((event, { value }) => value.set({ host: event }));
export default pattern<{}, { mine: PerUser<WriteAuthorizedBy<Entry, typeof f>>; fMine: Stream<string>; gMine: Stream<string> }>(() => {
  const mine = new Writable<PerUser<WriteAuthorizedBy<Entry, typeof f>> | undefined>(undefined).for("mine");
  return { mine: mine as any, fMine: f({ value: mine as any }), gMine: g({ value: mine as any }) };
});`,
      }],
    };

    /** A runtime over its own replicas of `server`, as a separate session is. */
    const sessionRuntime = (storage: EmulatedStorageManager) =>
      new Runtime(runtimePresets.patternTest({
        apiUrl: new URL(import.meta.url),
        storageManager: storage,
        experimental: {},
      }));

    it("does not seed it again when a later start finds it cleared", async () => {
      const creatorStorage = EmulatedStorageManager.connectTo(server, {
        as: signer,
      });
      const creator = sessionRuntime(creatorStorage);
      const coldStorage = EmulatedStorageManager.connectTo(server, {
        as: signer,
      });
      const cold = sessionRuntime(coldStorage);
      try {
        const setup = creator.edit();
        const compiled = await creator.patternManager.compilePattern(
          scopedProgram,
          { space, tx: setup },
        );
        const created = creator.run(
          setup,
          compiled,
          {},
          creator.getCell(space, "per-user-cell", undefined, setup),
        );
        creator.prepareTxForCommit(setup);
        expect((await setup.commit().settled).error).toBeUndefined();
        await created.pull();
        await creator.idle();
        expect(stored("mine", created, creator).status).toBe("loaded");
        expect(await send("fMine", "f", created, creator)).toEqual(["ok"]);
        expect(await send("fMine", "", created, creator)).toEqual(["ok"]);
        expect(host("mine", created)).toBeUndefined();
        await creator.storageManager.synced();

        // Every initialization the later start's transactions record.
        const initialized: string[] = [];
        const edit = cold.editWithRetry.bind(cold);
        cold.editWithRetry = (<T>(
          fn: (tx: IExtendedStorageTransaction) => T,
          ...rest: unknown[]
        ) =>
          edit((tx) => {
            const ran = fn(tx);
            for (const input of tx.getCfcState().writePolicyInputs) {
              if (input.kind === "initialization") {
                initialized.push(String(input.target.id));
              }
            }
            return ran;
          }, ...(rest as []))) as typeof cold.editWithRetry;
        const started = cold.getCell(space, "per-user-cell");
        await started.sync();
        expect(await cold.start(started)).toBe(true);
        await started.pull();
        await cold.idle();

        const mine = started.key("mine" as never).resolveAsCell()
          .getAsNormalizedFullLink();
        expect(initialized).not.toContain(mine.id);
        expect(stored("mine", started, cold).status).toBe("loaded");
        expect(String((await send("gMine", "g", started, cold))[0]))
          .toContain("writeAuthorizedBy");
        expect(await send("fMine", "f", started, cold)).toEqual(["ok"]);
        expect(host("mine", started)).toBe("f");
      } finally {
        await cold.dispose();
        await creator.dispose();
        await coldStorage.close();
        await creatorStorage.close();
      }
    });
  });
});
