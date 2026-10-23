/**
 * Holds `#profile`, a runtime's preferred profile, and the guard Home's
 * `retireProfile` keeps on the profile `#profile` returns to the rule for
 * which listed profiles are the person's: one whose name is attested to
 * someone else is none of theirs. The person's Home is the real pattern, its
 * profiles made by its own `createProfile`; a stranger makes a profile of
 * their own, through the profile's own `setName`, on a runtime of their own
 * over the same server, and a write no handler made links it from the
 * person's lists, which those lists take.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import type { JSONSchema } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import {
  markRendererTrustedEvent,
  reviewedActionProvenance,
} from "../src/cfc/ui-contract.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

const owner = await Identity.fromPassphrase("profile ownership owner");
const stranger = await Identity.fromPassphrase("profile ownership stranger");
const home = owner.did();

const linkListSchema = {
  type: "array",
  items: { type: "unknown", asCell: ["cell"] },
} as const satisfies JSONSchema;

/** The space `profile` lives in. */
function spaceOf(profile: Cell<unknown>): string {
  return profile.getAsNormalizedFullLink().space;
}

describe("profile-ownership", () => {
  let server: ReturnType<typeof newSharedServer>;
  let rt: Runtime;
  let host: Cell<Record<string, unknown>>;
  let ada: Cell<unknown>;
  let alan: Cell<unknown>;
  const opened: { runtime: Runtime; storage: EmulatedStorageManager }[] = [];

  beforeEach(async () => {
    server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    ({ runtime: rt } = open());
    const program = await systemProgram(rt, "home.tsx");
    const tx = rt.edit();
    const pattern = await rt.patternManager.compilePattern(program, {
      space: home,
      tx,
    });
    host = rt.getCell<Record<string, unknown>>(home, "home", undefined, tx);
    const result = rt.run(tx, pattern, {}, host);
    rt.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await result.pull();
    await link("defaultPattern", host);
    await create("Ada");
    await create("Alan");
    [ada, alan] = links("profiles");
  });

  afterEach(async () => {
    rt.runner.stop(host);
    for (const { runtime, storage } of opened.splice(0)) {
      await runtime.dispose({ closeStorage: false });
      await storage.close();
    }
    await server.close();
  });

  /** A runtime of its own over the shared server, acting as `as`. */
  function open(
    as: Identity = owner,
    preferredProfileSpace?: MemorySpace,
  ): { runtime: Runtime; storage: EmulatedStorageManager } {
    const storage = EmulatedStorageManager.connectTo(server, { as });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
      ...(preferredProfileSpace === undefined ? {} : { preferredProfileSpace }),
    });
    opened.push({ runtime, storage });
    return { runtime, storage };
  }

  /** The program of the system pattern `name`, resolved from the checkout. */
  function systemProgram(runtime: Runtime, name: string) {
    return resolveLocalProgram(
      (resolver) => runtime.harness.resolve(resolver),
      {
        main: new URL(`../../patterns/system/${name}`, import.meta.url)
          .pathname,
        root: new URL("../../..", import.meta.url).pathname.replace(/\/$/, ""),
      },
    );
  }

  /** Links `target` from the home space cell's `field`. */
  async function link(field: string, target: Cell<unknown>): Promise<void> {
    const tx = rt.edit();
    // deno-lint-ignore no-explicit-any
    (rt.getHomeSpaceCell(tx) as any).key(field).set(target);
    rt.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await rt.idle();
  }

  /** Sends `event` on Home's stream `stream`, and settles. */
  async function send(stream: string, event: unknown): Promise<void> {
    const tx = rt.edit();
    host.withTx(tx).key(stream).send(event);
    await tx.commit().settled;
    await rt.idle();
    await host.pull();
  }

  /** Creates a profile named `name`, as a click on the create form does. */
  async function create(name: string): Promise<void> {
    const event = {
      type: "click",
      name,
      provenance: reviewedActionProvenance("dom", {
        surface: "ProfileCreateSurface",
        action: "CreateProfile",
      }),
    };
    markRendererTrustedEvent(event);
    await send("createProfile", event);
  }

  /** The links Home's list under `key` holds. */
  function links(key: string): readonly Cell<unknown>[] {
    return host.key(key).asSchema(linkListSchema).get() ?? [];
  }

  /** The spaces of the profiles Home lists as retired, in order. */
  function retired(): string[] {
    return links("retiredProfiles").map(spaceOf);
  }

  /**
   * Makes a profile named `name` as the stranger, in the stranger's own
   * space, names it through its own `setName`, which labels the name as the
   * stranger's, and returns it as the owner's runtime holds it.
   */
  async function strangersProfile(name: string): Promise<Cell<unknown>> {
    const { runtime } = open(stranger);
    const program = await systemProgram(runtime, "profile-home.tsx");
    let tx = runtime.edit();
    const pattern = await runtime.patternManager.compilePattern(program, {
      space: stranger.did(),
      tx,
    });
    const profile = runtime.getCell<Record<string, unknown>>(
      stranger.did(),
      "a stranger's profile",
      undefined,
      tx,
    );
    runtime.run(tx, pattern, { initialName: name }, profile);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await profile.pull();
    tx = runtime.edit();
    profile.withTx(tx).key("setName").send({ name });
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.idle();
    await runtime.storageManager.synced();
    runtime.runner.stop(profile);
    return rt.getCellFromLink(profile.getAsNormalizedFullLink());
  }

  /**
   * Appends `profile` to Home's `profiles` and puts it at the head of its
   * `mru`, with writes no handler made, which both lists take, so that
   * `#profile` would answer with it if it were the person's.
   */
  async function listFirst(profile: Cell<unknown>): Promise<void> {
    for (const key of ["profiles", "mru"]) {
      const list = host.key(key).resolveAsCell().asSchema(linkListSchema);
      await list.sync();
      const tx = rt.edit();
      const held = list.withTx(tx).get() ?? [];
      list.withTx(tx).set(
        key === "mru" ? [profile, ...held] : [...held, profile],
      );
      rt.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
      await rt.idle();
    }
    await host.pull();
  }

  /**
   * The name of the profile `#profile` answers with on `runtime`, or the
   * message of the error the wish reports.
   */
  async function profileAnswer(runtime: Runtime): Promise<unknown> {
    const { pattern, wish } = createTrustedBuilder(runtime).commonfabric;
    const tx = runtime.edit();
    const result = runtime.run(
      tx,
      pattern(() => ({ profile: wish({ query: "#profile", headless: true }) })),
      {},
      runtime.getCell<Record<string, unknown>>(
        home,
        `profile ownership wish ${crypto.randomUUID()}`,
        undefined,
        tx,
      ),
    );
    await tx.commit().settled;
    await result.pull();
    // deno-lint-ignore no-explicit-any
    const state = result.key("profile").get() as any;
    return state?.result?.name ?? String(state?.error);
  }

  it("answers `#profile` with the person's own profile, not one listed ahead of it whose name is a stranger's", async () => {
    await listFirst(await strangersProfile("Mallory"));

    expect(await profileAnswer(rt)).toBe("Ada");
  });

  it("refuses a runtime's preferred profile whose name is a stranger's", async () => {
    const theirs = await strangersProfile("Mallory");
    await listFirst(theirs);
    const { runtime } = open(owner, spaceOf(theirs) as MemorySpace);

    expect(await profileAnswer(runtime)).toContain(
      "not one of the user's profiles",
    );
  });

  it("refuses to retire the profile `#profile` returns when a listed profile whose name is a stranger's is most recently used", async () => {
    await listFirst(await strangersProfile("Mallory"));

    await send("retireProfile", { profile: ada });
    expect(retired()).toEqual([]);

    await send("retireProfile", { profile: alan });
    expect(retired()).toEqual([spaceOf(alan)]);
  });

  it("refuses to retire the profile `#profile` returns when a listed profile whose document is absent is most recently used", async () => {
    const elsewhere = await rt.createSpace({ grants: { "*": "WRITE" } });
    await listFirst(rt.getCell(elsewhere, "no profile is here"));

    expect(await profileAnswer(rt)).toBe("Ada");
    await send("retireProfile", { profile: ada });
    expect(retired()).toEqual([]);

    await send("retireProfile", { profile: alan });
    expect(retired()).toEqual([spaceOf(alan)]);
  });
});
