/** Private member controls used by two viewers and two sessions of one viewer. */
import { expect } from "@std/expect";
import { join } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import type { DID } from "@commonfabric/identity";
import { Identity } from "@commonfabric/identity";
import { env, type Page, waitForCondition } from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { type Cell, parseLink, type Runtime } from "@commonfabric/runner";
import {
  markRendererTrustedEvent,
  reviewedActionProvenance,
} from "@commonfabric/runner/cfc";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { getLoggerCountsBreakdown } from "@commonfabric/utils/logger";

import { loadStoredCfcEnvelope } from "../../runner/src/cfc/prepare.ts";
import {
  clickCfButton,
  clickTrustedAction,
  fillCfInput,
  waitForRuntimeIdle,
  waitForSettledText,
} from "./cfc-browser-helpers.ts";
import {
  initializePiecesController,
  type PiecesController,
} from "./pieces-controller.ts";

const { API_URL, FRONTEND_URL } = env;
const PATTERNS = join(import.meta.dirname!, "..");
const HOME = join(
  import.meta.dirname!,
  "fixtures/fabrichat-private-member-ui/home.tsx",
);
const PEOPLE = "#fabrichat-add-member-people";
const FEEDBACK = "#fabrichat-add-member-outcome";
const PERSONAL = "https://commonfabric.org/cfc/atom/PersonalSpace";

/** Resolves an opaque cell-valued reference to its piece's canonical result. */
async function pieceAt(runtime: Runtime, at: Cell<unknown>) {
  const reference = await at.asSchema<Cell<unknown>>({ asCell: ["cell"] })
    .pull();
  if (!reference) throw new Error("The fixture's piece reference is absent.");
  const handle = runtime.getCellFromLink(
    reference.getAsNormalizedFullLink(),
    {},
  );
  await handle.sync();
  const piece = handle.resolveAsCell();
  await piece.sync();
  return piece;
}

interface Room {
  spaceDid: DID;
  pieceId: string;
}

/** An event bearing the room-start action the renderer supplies. */
function start(event: Record<string, unknown>): Record<string, unknown> {
  const click = {
    type: "click",
    ...event,
    provenance: reviewedActionProvenance("dom", {
      surface: "ChatStartSurface",
      action: "ChatStart",
    }),
  };
  markRendererTrustedEvent(click);
  return click;
}

/** Runs one fixture Home with a durability barrier before closing its runtime. */
async function inHome<T>(
  identity: Identity,
  use: (controller: PiecesController, home: Cell<unknown>) => Promise<T>,
): Promise<T> {
  const refusedBefore =
    getLoggerCountsBreakdown().cfc?.["write-policy-gate"]?.total ?? 0;
  const controller = await initializePiecesController({
    apiUrl: new URL(API_URL),
    identity,
    space: identity.did(),
  });
  try {
    const existing = await controller.getDefaultPattern(false);
    let home: Cell<unknown>;
    if (existing) {
      home = controller.getResult(existing);
      await controller.getPieceCell(existing, true);
    } else {
      const program = await resolveLocalProgram(
        (resolver) => controller.runtime.harness.resolve(resolver),
        { main: HOME, root: PATTERNS },
      );
      const entry = program.files.find((file) => file.name === program.main);
      if (!entry) throw new Error("The fixture's entry module is absent.");
      entry.contents = entry.contents.replace(
        "did:key:z6MkqonmiAA2fg5wAEkagDYr8ghbNvmRD4QBTCB8tihLvHuN",
        identity.did(),
      );
      const piece = await controller.create(program, { start: true });
      home = controller.getResult(piece.getCell());
      const tx = controller.runtime.edit();
      controller.runtime.getHomeSpaceCell(tx).key("defaultPattern").set(home);
      controller.runtime.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
    }
    const cancel = home.sink(() => {});
    try {
      await controller.runtime.settled();
      const value = await use(controller, home);
      await controller.runtime.settled();
      expect(getLoggerCountsBreakdown().cfc?.["write-policy-gate"]?.total ?? 0)
        .toBe(refusedBefore);
      return value;
    } finally {
      cancel();
      await controller.runtime.settled();
    }
  } finally {
    await controller.dispose();
  }
}

/** Seeds a real profile and inbox, then proves the manager's stored root label. */
async function createHome(identity: Identity, name: string) {
  return await inHome(identity, async (controller, home) => {
    const send = async (stream: string, event: Record<string, unknown>) => {
      const tx = controller.runtime.edit();
      home.withTx(tx).key(stream).send(event);
      controller.runtime.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
      await controller.runtime.settled();
    };
    await send("createProfile", { name });
    const profile = await pieceAt(
      controller.runtime,
      home.key("profiles").key(0),
    );
    const naming = controller.runtime.edit();
    profile.withTx(naming).key("setName").send({ name });
    controller.runtime.prepareTxForCommit(naming);
    expect((await naming.commit().settled).error).toBeUndefined();
    await controller.runtime.settled();
    expect(await profile.key("name").pull()).toBe(name);
    await send("ensurePrivateInbox", {});
    const manager = home.key("chatManager").resolveAsCell();
    const inspection = controller.runtime.edit();
    const envelope = loadStoredCfcEnvelope(
      inspection,
      manager.getAsNormalizedFullLink(),
    );
    expect(envelope.status).toBe("loaded");
    if (envelope.status === "loaded") {
      expect(envelope.metadata.labelMap.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: [],
            origin: "declared",
            label: expect.objectContaining({
              confidentiality: expect.arrayContaining([{
                type: PERSONAL,
                owner: identity.did(),
              }]),
            }),
          }),
        ]),
      );
    }
    inspection.abort();
    return profile.toSigilLinkOrNull();
  });
}

/** Creates a group through the manager's reviewed command. */
async function group(
  owner: Identity,
  requestId: string,
  profiles: unknown[],
): Promise<Room> {
  return await inHome(owner, async (controller, home) => {
    // A profile picked in the UI has already been loaded, including its inbox.
    for (const profile of profiles) {
      const link = parseLink(profile);
      if (!link?.id || !link.space) throw new Error("The profile has no link.");
      await controller.runtime.getCellFromLink(link).pull();
    }
    const tx = controller.runtime.edit();
    home.withTx(tx).key("createGroup").send(start({
      requestId,
      title: requestId,
      members: [],
      profiles,
    }));
    controller.runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await controller.runtime.settled();
    const outcome = home.key("requests").key(requestId);
    expect(await outcome.key("status").pull()).toBe("done");
    const room = await pieceAt(
      controller.runtime,
      outcome.key("entry").key("room"),
    );
    expect(await room.key("roster").pull()).toHaveLength(profiles.length + 1);
    const space = room.space;
    expect(space).not.toBe(owner.did());
    const root = controller.runtime.getSpaceCell(space).key("defaultPattern");
    await root.sync();
    const link = root.resolveAsCell().getAsNormalizedFullLink();
    expect(link.id.startsWith("of:")).toBe(true);
    return { spaceDid: link.space, pieceId: link.id };
  });
}

/** Reads text through the integration probe's shadow-piercing traversal. */
async function textAt(page: Page, selector: string): Promise<string> {
  await waitForRuntimeIdle(page);
  const result = await waitForCondition(page, (probe, selector: string) => {
    const root = probe.collect(selector)[0];
    return root ? { text: probe.deepText(root).trim() } : false;
  }, { args: [selector] });
  return (result as { text: string }).text;
}

/** Reads the settled candidate names without revealing other UI text. */
async function candidates(page: Page): Promise<string> {
  return await textAt(page, PEOPLE);
}

/** The runtime's CFC write-refusal counter, from the worker running the UI. */
async function refusals(page: Page): Promise<number> {
  return await page.evaluate(async () => {
    const rt = (globalThis as typeof globalThis & {
      commonfabric?: {
        rt?: {
          getLoggerCounts(): Promise<
            { counts: Record<string, Record<string, { total: number }>> }
          >;
        };
      };
    }).commonfabric?.rt;
    if (!rt) throw new Error("The runtime is absent.");
    const { counts } = await rt.getLoggerCounts();
    return counts.cfc?.["write-policy-gate"]?.total ?? 0;
  });
}

describe("fabrichat-private-member-browser", () => {
  const first = new ShellIntegration();
  first.bindLifecycle();
  const sameUser = new ShellIntegration();
  sameUser.bindLifecycle();
  const otherUser = new ShellIntegration();
  otherUser.bindLifecycle();

  it("keeps private candidates and feedback personal while a picked profile is admitted to the shared room", async () => {
    const alice = await Identity.generate({ implementation: "noble" });
    const bob = await Identity.generate({ implementation: "noble" });
    const carol = await Identity.generate({ implementation: "noble" });
    const dave = await Identity.generate({ implementation: "noble" });
    const aliceProfile = await createHome(alice, "Alice private picker");
    const bobProfile = await createHome(bob, "Bob private picker");
    const carolProfile = await createHome(carol, "Carol only Alice knows");
    const daveProfile = await createHome(dave, "Dave only Bob knows");
    expect(aliceProfile).not.toBeNull();
    expect(bobProfile).not.toBeNull();
    expect(carolProfile).not.toBeNull();
    expect(daveProfile).not.toBeNull();
    await group(alice, "Alice met Carol", [carolProfile]);
    await group(bob, "Bob met Dave", [daveProfile]);
    const room = await group(alice, "Private controls shared room", [
      bobProfile,
    ]);

    await first.goto({
      frontendUrl: FRONTEND_URL,
      view: room,
      identity: alice,
    });
    await waitForRuntimeIdle(first.page());
    expect(await refusals(first.page())).toBe(0);
    await waitForSettledText(first.page(), PEOPLE, "Carol only Alice knows");
    expect(await candidates(first.page())).not.toContain("Dave only Bob knows");
    await sameUser.goto({
      frontendUrl: FRONTEND_URL,
      view: room,
      identity: alice,
    });
    await waitForRuntimeIdle(sameUser.page());
    expect(await refusals(sameUser.page())).toBe(0);
    await waitForSettledText(sameUser.page(), PEOPLE, "Carol only Alice knows");
    await otherUser.goto({
      frontendUrl: FRONTEND_URL,
      view: room,
      identity: bob,
    });
    await waitForRuntimeIdle(otherUser.page());
    expect(await refusals(otherUser.page())).toBe(0);
    await waitForSettledText(otherUser.page(), PEOPLE, "Dave only Bob knows");
    expect(await candidates(otherUser.page())).not.toContain(
      "Carol only Alice knows",
    );

    await clickCfButton(
      first.page(),
      `${PEOPLE} cf-button[data-ui-action="ChatAddMember"]`,
    );
    await waitForSettledText(
      first.page(),
      FEEDBACK,
      `Added ${carol.did()}, and offered them this chat.`,
    );
    await waitForRuntimeIdle(sameUser.page());
    await waitForRuntimeIdle(otherUser.page());
    expect(
      await textAt(first.page(), FEEDBACK),
    ).toContain(carol.did());
    expect(
      await textAt(sameUser.page(), FEEDBACK),
    ).toBe("");
    expect(
      await textAt(otherUser.page(), FEEDBACK),
    ).toBe("");
    expect(await candidates(otherUser.page())).toContain("Dave only Bob knows");

    await fillCfInput(
      otherUser.page(),
      "#fabrichat-add-member-address",
      "invalid address",
    );
    await clickTrustedAction(otherUser.page(), "ChatAddMember");
    await waitForSettledText(
      otherUser.page(),
      FEEDBACK,
      "That isn't a chat address.",
    );
    expect(
      await textAt(first.page(), FEEDBACK),
    ).toContain(carol.did());
    expect(await refusals(first.page())).toBe(0);
    expect(await refusals(sameUser.page())).toBe(0);
    expect(await refusals(otherUser.page())).toBe(0);

    await first.goto({
      frontendUrl: FRONTEND_URL,
      view: room,
      identity: alice,
    });
    await waitForSettledText(
      first.page(),
      "#fabrichat-messages",
      "No messages yet",
    );
    await waitForCondition(
      first.page(),
      (probe) =>
        probe.collect("cf-profile-badge").some((badge) =>
          probe.deepText(badge).includes("Carol only Alice knows")
        ),
    );
    expect(
      await textAt(first.page(), FEEDBACK),
    ).toBe("");
    expect(await refusals(first.page())).toBe(0);
  });
});
