/** Contrasts populated production AddMember displays over public and private manager data. */

import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import {
  isCell,
  type JSONSchema,
  Runtime,
  RuntimeTelemetryEvent,
  type RuntimeTelemetryMarker,
} from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";

import { debugVDOMSchema } from "@commonfabric/runner/schemas";
import { getLoggerCountsBreakdown } from "@commonfabric/utils/logger";

import { loadStoredCfcEnvelope } from "../../runner/src/cfc/prepare.ts";

const owner = await Identity.fromPassphrase("fabrichat-manager-roles");
const PATTERNS = fromFileUrl(new URL("..", import.meta.url));

describe("fabrichat-private-member-ui", () => {
  let server: ReturnType<typeof newLoopbackServer>;
  let storage: EmulatedStorageManager;
  let runtime: Runtime;
  let observation: AbortController;
  let refusals: Extract<
    RuntimeTelemetryMarker,
    { type: "cfc.prepare-reject" }
  >[];

  beforeEach(() => {
    server = newLoopbackServer();
    storage = EmulatedStorageManager.connectTo(server, { as: owner });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    observation = new AbortController();
    refusals = [];
    runtime.telemetry.addEventListener("telemetry", (event) => {
      if (
        event instanceof RuntimeTelemetryEvent &&
        event.marker.type === "cfc.prepare-reject"
      ) refusals.push(event.marker);
    }, { signal: observation.signal });
  });

  afterEach(async () => {
    await runtime?.settled();
    observation?.abort();
    await runtime?.dispose();
    await storage?.close();
    await server?.close();
  });

  for (
    const { name, labeled, late, provided } of [
      { name: "public", labeled: false, late: false, provided: true },
      { name: "root-private", labeled: true, late: false, provided: true },
      { name: "late private", labeled: true, late: true, provided: true },
      { name: "missing", labeled: false, late: false, provided: false },
    ]
  ) {
    it(`renders the viewer's candidates and delivery results with a ${name} manager`, async () => {
      const staleBefore =
        getLoggerCountsBreakdown()["storage.v2.multi-space-commit"]
          ?.["multi-space-commit-stale"]?.total ?? 0;
      expect(runtime.cfcEnforcementMode).toBe("enforce-strict");
      const home = owner.did();
      const social = await runtime.createSpace({});
      const profileSpace = await runtime.createSpace({});
      const profileTx = runtime.edit();
      const profile = runtime.getCell(profileSpace, "viewer profile", {
        type: "object",
        properties: { name: { type: "string" } },
        ifc: { addIntegrity: ["fabrichat-test-profile"] },
      }, profileTx);
      profile.set({ name: "Viewer" });
      const counterpart =
        (await Identity.fromPassphrase("private UI candidate")).did();
      const candidate = runtime.getCell(profileSpace, "candidate profile", {
        type: "object",
        properties: { name: { type: "string" } },
        ifc: { addIntegrity: ["fabrichat-test-profile"] },
      }, profileTx);
      candidate.set({ name: "Candidate" });
      runtime.prepareTxForCommit(profileTx);
      expect((await profileTx.commit().settled).error).toBeUndefined();
      const tx = runtime.edit();
      const endpoint = (name: string) => {
        const cell = runtime.getCell(home, name, undefined, tx);
        cell.set({ $stream: true });
        return cell;
      };
      const offerRoom = endpoint("offerRoom");
      const joinRoom = endpoint("joinRoom");
      const openDirect = endpoint("openDirect");
      const managerSchema = {
        type: "object",
        properties: {
          offerRoom: { asCell: ["stream"] },
          joinRoom: { asCell: ["stream"] },
          openDirect: { asCell: ["stream"] },
          requests: { type: "object", additionalProperties: true },
          people: { type: "object", additionalProperties: true },
        },
        ...(labeled
          ? {
            ifc: {
              confidentiality: [{
                type: "https://commonfabric.org/cfc/atom/PersonalSpace",
                owner: home,
              }],
            },
          }
          : {}),
      } as const satisfies JSONSchema;
      const manager = runtime.getCell(
        home,
        "manager core",
        managerSchema,
        tx,
      );
      manager.set({
        offerRoom,
        joinRoom,
        openDirect,
        requests: {
          [JSON.stringify(["addMember", social, "probe-add"])]: {
            status: "refused",
            reason: "probe-refused",
          },
        },
        people: { [counterpart]: [candidate] },
      });
      // The wrapper reaches the core through a document-valued link, without
      // carrying the writer's confidentiality declaration as a reader schema.
      const mid = runtime.getCell(home, "manager mid", undefined, tx);
      const { schema: _schema, ...untypedManagerLink } = manager
        .getAsNormalizedFullLink();
      mid.set(runtime.getCellFromLink(untypedManagerLink));
      const wrapper = runtime.getCell(home, "manager wrapper", undefined, tx);
      wrapper.set({
        offerRoom: mid.key("offerRoom"),
        joinRoom: mid.key("joinRoom"),
        openDirect: mid.key("openDirect"),
        requests: mid.key("requests"),
        people: mid.key("people"),
      });
      const suppliedManager = runtime.getCell(
        home,
        "manager arrival",
        undefined,
        tx,
      );
      if (!late) suppliedManager.set(wrapper);
      const homeRoot = runtime.getCell(home, "Home root", undefined, tx);
      homeRoot.set({ chatManager: wrapper, profiles: [profile] });
      runtime.getSpaceCell(home, undefined, tx).key("defaultPattern").set(
        homeRoot,
      );
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();

      const inspection = runtime.edit();
      const envelope = loadStoredCfcEnvelope(
        inspection,
        manager.getAsNormalizedFullLink(),
      );
      expect(envelope.status).toBe("loaded");
      if (envelope.status === "loaded" && labeled) {
        expect(envelope.metadata.labelMap.entries).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              path: [],
              origin: "declared",
              label: expect.objectContaining({
                confidentiality: expect.arrayContaining([{
                  type: "https://commonfabric.org/cfc/atom/PersonalSpace",
                  owner: home,
                }]),
              }),
            }),
          ]),
        );
      }
      inspection.abort();
      const program = await resolveLocalProgram(
        (resolver) => runtime.harness.resolve(resolver),
        {
          main: fromFileUrl(
            new URL(
              "./fixtures/fabrichat-private-member-ui/main.tsx",
              import.meta.url,
            ),
          ),
          root: PATTERNS,
        },
      );
      const roomTx = runtime.edit();
      const records = runtime.getCell(
        social,
        "probe-records",
        undefined,
        roomTx,
      );
      records.set([]);
      const addRequests = runtime.getCell(
        social,
        "probe-addRequests",
        undefined,
        roomTx,
      );
      addRequests.set({ "probe-add": { status: "done" } });
      const pattern = await runtime.patternManager.compilePattern(program, {
        space: social,
        tx: roomTx,
      });
      const room = runtime.run(
        roomTx,
        pattern,
        {
          profile,
          ...(provided ? { manager: suppliedManager } : {}),
          records,
          addRequests,
        },
        runtime.getCell(social, "room", undefined, roomTx),
      );
      runtime.prepareTxForCommit(roomTx);
      expect((await roomTx.commit().settled).error).toBeUndefined();
      await runtime.settled();
      await room.pull();
      const ui = room.key("$UI").asSchema(debugVDOMSchema);
      const stop = ui.sink(() => {});
      let badges = 0;
      const visit = async (node: unknown): Promise<void> => {
        if (isCell(node)) {
          await node.pull();
          return visit(node.get());
        }
        if (Array.isArray(node)) {
          for (const child of node) await visit(child);
        } else if (node && typeof node === "object") {
          if ("name" in node && node.name === "cf-profile-badge") badges++;
          if ("$UI" in node) await visit(node.$UI);
          if ("children" in node) await visit(node.children);
        }
      };
      await visit(await ui.pull());
      await runtime.settled();
      if (late) {
        expect(badges).toBe(0);
        const arrival = runtime.edit();
        suppliedManager.withTx(arrival).set(wrapper);
        runtime.prepareTxForCommit(arrival);
        expect((await arrival.commit().settled).error).toBeUndefined();
        await runtime.settled();
        badges = 0;
        await visit(await ui.pull());
      }
      stop();
      expect(refusals.map((marker) => marker.reasons)).toEqual([]);
      expect(badges).toBe(provided ? 1 : 0);
      expect(
        getLoggerCountsBreakdown()["storage.v2.multi-space-commit"]
          ?.["multi-space-commit-stale"]?.total ?? 0,
      ).toBe(staleBefore);
      expect(await room.key("outcomes").pull()).toEqual({
        "probe-add": provided
          ? {
            status: "done",
            delivery: "access-only",
            deliveryRefusal: "probe-refused",
          }
          : { status: "done" },
      });
    });
  }
});
