/**
 * Two runtimes on one in-process memory server enforcing ACLs: an owner who
 * can read every space, and a reader who can read some. The reader's
 * computations follow links from a space it may read into one it may not,
 * which is what `deniedInputsUnavailable` decides the fate of.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import type { MemorySpace, Signer } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { authorizeLoopbackSessionOpen } from "@commonfabric/memory/v2/session-open-auth";
import { defer } from "@commonfabric/utils/defer";

import { ACLManager } from "../src/acl-manager.ts";
import { type ExperimentalOptions, Runtime } from "../src/runtime.ts";
import type { Action } from "../src/scheduler.ts";
import {
  type Options,
  type SessionFactory,
  StorageManager,
} from "../src/storage/v2.ts";

const AUDIENCE = "did:key:z6Mk-runner-denied-reads-audience";

/**
 * Opens each session on the one in-process server, as `signer`. A session
 * open of `space` waits for `holdOpen` to resolve, when one is set for it.
 */
class LoopbackSessionFactory implements SessionFactory {
  readonly supportsAclBootstrap = true;
  readonly holdOpen = new Map<MemorySpace, Promise<void>>();
  readonly #server: MemoryV2Server.Server;

  constructor(server: MemoryV2Server.Server) {
    this.#server = server;
  }

  async create(
    space: MemorySpace,
    signer?: Signer,
    requested: MemoryV2Client.MountOptions = {},
  ) {
    await this.holdOpen.get(space);
    const client = await MemoryV2Client.connect({
      transport: MemoryV2Client.loopback(this.#server),
    });
    const session = await client.mount(
      space,
      requested,
      (_space, _session, context) => ({
        invocation: {
          aud: context.audience,
          challenge: context.challenge.value,
        },
        authorization: { principal: signer?.did() },
      }),
    );
    return { client, session };
  }
}

class TestStorageManager extends StorageManager {
  static overServer(
    options: Omit<Options, "memoryHost">,
    factory: SessionFactory,
  ): TestStorageManager {
    return new TestStorageManager(
      { ...options, memoryHost: new URL("memory://") },
      factory,
    );
  }
}

type Profile = { name: string };
type Roster = { member: Profile | undefined };

describe("denied reads", () => {
  let server: MemoryV2Server.Server;
  let runtimes: Runtime[];
  let factories: Map<Runtime, LoopbackSessionFactory>;

  const open = (
    identity: Identity,
    experimental?: ExperimentalOptions,
  ): Runtime => {
    const factory = new LoopbackSessionFactory(server);
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: TestStorageManager.overServer({ as: identity }, factory),
      experimental,
    });
    runtimes.push(runtime);
    factories.set(runtime, factory);
    return runtime;
  };

  beforeEach(() => {
    server = new MemoryV2Server.Server({
      store: new URL(`memory://denied-reads-${crypto.randomUUID()}`),
      authorizeSessionOpen: authorizeLoopbackSessionOpen,
      sessionOpenAuth: { audience: AUDIENCE },
      acl: { mode: "enforce" },
      subscriptionRefreshDelayMs: 0,
    });
    runtimes = [];
    factories = new Map();
  });

  afterEach(async () => {
    for (const runtime of runtimes) await runtime.dispose();
    await server.close();
  });

  /**
   * Three spaces of the owner's: `hidden`, which the reader has no grant on
   * and which holds a profile; `shared`, which the reader may read and
   * which holds a roster linking to that profile, or to a document nobody
   * wrote when `memberIn` is `shared`; and `out`, which the reader may write.
   * The reader's runtime takes `experimental`. With `refuseFirst`, the reader
   * asks for the profile before its computation runs, so the refusal of
   * `hidden` is known to it by then; with `holdHidden`, its session opens of
   * `hidden` wait on that promise instead, so the refusal arrives later.
   */
  const scene = async (
    experimental: ExperimentalOptions,
    options: {
      memberIn?: "hidden" | "shared";
      refuseFirst?: boolean;
      holdHidden?: Promise<void>;
    } = {},
  ) => {
    const owner = await Identity.fromPassphrase("denied reads owner");
    const reader = await Identity.fromPassphrase("denied reads reader");
    const ownerRuntime = open(owner);
    const hidden = await ownerRuntime.createSpace({ grants: {} });
    const shared = await ownerRuntime.createSpace({
      grants: { [reader.did()]: "READ" },
    });
    const out = await ownerRuntime.createSpace({
      grants: { [reader.did()]: "WRITE" },
    });
    const profile = ownerRuntime.getCell<Profile>(hidden, "profile");
    await ownerRuntime.editWithRetry((tx) => {
      profile.withTx(tx).set({ name: "Ada" });
    });
    const member = options.memberIn === "shared"
      ? ownerRuntime.getCell<Profile>(shared, "nobody-wrote-this")
      : profile;
    await ownerRuntime.editWithRetry((tx) => {
      ownerRuntime.getCell<Roster>(shared, "roster", undefined, tx)
        .set({ member });
    });
    await ownerRuntime.storageManager.synced();

    const readerRuntime = open(reader, experimental);
    if (options.holdHidden !== undefined) {
      factories.get(readerRuntime)!.holdOpen.set(hidden, options.holdHidden);
    }
    const roster = readerRuntime.getCell<Roster>(shared, "roster");
    const summary = readerRuntime.getCell<string>(out, "summary");
    await roster.sync();
    await summary.sync();
    if (options.refuseFirst === true) {
      await readerRuntime.getCell<Profile>(hidden, "profile").sync()
        .catch(() => {});
      await readerRuntime.storageManager.synced();
    }

    // The reader's computation: the member's name, or `unknown` for a member
    // it reads nothing for, written to `out` when it differs. `runs` counts
    // the body's runs, whether or not the run was committed.
    const counts = { runs: 0 };
    const action: Action = (tx) => {
      counts.runs++;
      const name = roster.withTx(tx).key("member").get()?.name ?? "unknown";
      if (summary.withTx(tx).get() !== name) summary.withTx(tx).set(name);
    };
    readerRuntime.scheduler.subscribe(
      action,
      { reads: [], shallowReads: [], writes: [] },
      { isEffect: true },
    );
    // A load that fails on a refusal settles inside `synced()`, and the runs
    // the refusal wakes are queued from there, so the reader is idle again
    // only after a second wait.
    const settled = async () => {
      await readerRuntime.scheduler.idleWithPendingCommits();
      await readerRuntime.storageManager.synced();
      await readerRuntime.scheduler.idleWithPendingCommits();
    };
    const stored = async () => {
      const cell = ownerRuntime.getCell<string>(out, "summary");
      await ownerRuntime.storageManager.pullOpenSpacesToHead();
      await cell.sync();
      return cell.get();
    };
    return {
      ownerRuntime,
      readerRuntime,
      hidden,
      out,
      reader,
      summary,
      counts,
      settled,
      stored,
    };
  };

  it("commits what a run computed from a space it was refused when the flag is off", async () => {
    const { counts, settled, stored } = await scene({
      deniedInputsUnavailable: false,
    });
    await settled();

    expect(counts.runs).toBe(1);
    expect(await stored()).toBe("unknown");
  });

  it("parks a run that read a space it was refused, and commits nothing", async () => {
    const { readerRuntime, hidden, counts, settled, stored } = await scene(
      { deniedInputsUnavailable: true },
      { refuseFirst: true },
    );
    expect(readerRuntime.storageManager.spaceAccessError?.(hidden))
      .toBeDefined();
    await settled();

    expect(counts.runs).toBe(1);
    expect(await stored()).toBeUndefined();
  });

  it("runs the parked run again once the principal is granted the space, and it commits what it read", async () => {
    const {
      ownerRuntime,
      readerRuntime,
      hidden,
      reader,
      counts,
      settled,
      stored,
    } = await scene({ deniedInputsUnavailable: true }, { refuseFirst: true });
    await settled();
    expect(await stored()).toBeUndefined();

    await new ACLManager(ownerRuntime, hidden).grant(reader.did(), "READ");
    await readerRuntime.storageManager.retrySpaceAccess?.(hidden);
    await settled();

    expect(counts.runs).toBeGreaterThan(1);
    expect(await stored()).toBe("Ada");
  });

  it("commits a run that read a document nobody wrote in a space it may read", async () => {
    const { counts, settled, stored } = await scene(
      { deniedInputsUnavailable: true },
      { memberIn: "shared" },
    );
    await settled();

    expect(counts.runs).toBe(1);
    expect(await stored()).toBe("unknown");
  });

  it("runs a reader of the space again when the refusal arrives after it committed, and that run parks", async () => {
    // The reader's session open of `hidden` is held until the first run has
    // committed, so that run reads an absence rather than a refusal.
    const release = defer();
    const { ownerRuntime, readerRuntime, out, counts, settled, stored } =
      await scene(
        { deniedInputsUnavailable: true },
        { holdHidden: release.promise },
      );
    // `synced()` would wait on the held open, so this waits on the commit
    // alone.
    await readerRuntime.scheduler.idleWithPendingCommits();
    expect(counts.runs).toBe(1);
    expect(await stored()).toBe("unknown");

    release.resolve();
    await settled();
    expect(counts.runs).toBeGreaterThan(1);
    expect(await stored()).toBe("unknown");

    // The owner, who reads everything, corrects the summary. The reader runs
    // again on the change and parks, so the correction stands.
    await ownerRuntime.editWithRetry((tx) => {
      ownerRuntime.getCell<string>(out, "summary", undefined, tx).set("Ada");
    });
    await ownerRuntime.storageManager.synced();
    await readerRuntime.storageManager.pullOpenSpacesToHead();
    await settled();

    expect(await stored()).toBe("Ada");
  });
});
