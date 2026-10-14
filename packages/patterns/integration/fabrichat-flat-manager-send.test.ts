/** A production room send over flat bindings in a synthetic Home wrapper chain. */

import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import {
  type JSONSchema,
  Runtime,
  RuntimeTelemetryEvent,
  type RuntimeTelemetryMarker,
} from "@commonfabric/runner";
import {
  markRendererTrustedEvent,
  reviewedActionProvenance,
} from "@commonfabric/runner/cfc";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";

const owner = await Identity.fromPassphrase("fabrichat-manager-roles");
const PATTERNS = fromFileUrl(new URL("..", import.meta.url));

describe("FabriChat flat manager sends", () => {
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
    await runtime?.idle();
    await storage?.synced();
    observation?.abort();
    await runtime?.dispose();
    await storage?.close();
    await server?.close();
  });

  for (const discovered of [false, true]) {
    for (const labeled of [false, true]) {
      it(`stores a shared message through a ${labeled ? "root-private" : "public"} manager's ${discovered ? "discovered" : "supplied"} flat bindings`, async () => {
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
          requests: { privateRequest: { status: "pending" } },
          people: {},
        });
        // The fixture models Home's wrapper and document-valued link to the
        // core. Only the room's manager discovery runs production Home access.
        const mid = runtime.getCell(home, "manager mid", undefined, tx);
        mid.set(manager);
        const wrapper = runtime.getCell(home, "manager wrapper", undefined, tx);
        wrapper.set({
          offerRoom: mid.key("offerRoom"),
          joinRoom: mid.key("joinRoom"),
          openDirect: mid.key("openDirect"),
          requests: mid.key("requests"),
          people: mid.key("people"),
        });
        const homeRoot = runtime.getCell(home, "Home root", undefined, tx);
        homeRoot.set({ chatManager: wrapper, profiles: [profile] });
        runtime.getSpaceCell(home, undefined, tx).key("defaultPattern").set(
          homeRoot,
        );
        runtime.prepareTxForCommit(tx);
        expect((await tx.commit().settled).error).toBeUndefined();

        const program = await resolveLocalProgram(
          (resolver) => runtime.harness.resolve(resolver),
          {
            main: fromFileUrl(
              new URL(
                discovered
                  ? "../fabrichat/room.tsx"
                  : "./fixtures/fabrichat-flat-manager-send/main.tsx",
                import.meta.url,
              ),
            ),
            root: PATTERNS,
          },
        );
        const roomTx = runtime.edit();
        const pattern = await runtime.patternManager.compilePattern(program, {
          space: social,
          tx: roomTx,
        });
        const room = runtime.run(
          roomTx,
          pattern,
          discovered ? {} : { profile, manager: wrapper },
          runtime.getCell(social, "room", undefined, roomTx),
        );
        runtime.prepareTxForCommit(roomTx);
        expect((await roomTx.commit().settled).error).toBeUndefined();
        await runtime.idle();
        await room.pull();
        // Root-private setup can refuse one manager-derived computation. This
        // send guard bounds that known debt and permits no additional refusal.
        expect(refusals.length).toBeLessThanOrEqual(labeled ? 1 : 0);
        for (const refusal of refusals) {
          expect(refusal.terminal).toBe(true);
          expect(refusal.reasons.length).toBeGreaterThan(0);
          expect(
            refusal.reasons.every((reason) =>
              reason.includes("writer-fit confidentiality misfit") &&
              reason.includes("PersonalSpace")
            ),
          ).toBe(true);
        }
        const refusedBeforeSend = refusals.length;
        const click = {
          type: "click",
          requestId: "flat-manager-send",
          target: { value: "A shared message" },
          provenance: reviewedActionProvenance("dom", {
            surface: "ChatSendSurface",
            action: "ChatSend",
          }),
        };
        markRendererTrustedEvent(click);
        const sendTx = runtime.edit();
        room.withTx(sendTx).key("sendMessage").send(click);
        expect((await sendTx.commit().settled).error).toBeUndefined();
        await runtime.idle();
        await room.pull();
        expect(await room.key("messages").key("count").pull()).toBe(1);
        expect(
          await room.key("messages").key("latest").key("messages").key(0).key(
            "body",
          ).pull(),
        ).toBe("A shared message");
        expect(refusals.length).toBe(refusedBeforeSend);
      });
    }
  }
});
