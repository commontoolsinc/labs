/** A shared room reaching Home's manager through its live wrapper link chain. */

import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import { type JSONSchema, Runtime } from "@commonfabric/runner";
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

describe("FabriChat manager roles", () => {
  let server: ReturnType<typeof newLoopbackServer>;
  let storage: EmulatedStorageManager;
  let runtime: Runtime;

  beforeEach(() => {
    server = newLoopbackServer();
    storage = EmulatedStorageManager.connectTo(server, { as: owner });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
  });

  afterEach(async () => {
    await runtime?.idle();
    await storage?.synced();
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
        // Home publishes the manager wrapper, whose fields resolve through a
        // document-valued link to the core. The core alone carries the label.
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
                  : "./fixtures/fabrichat-manager-roles/main.tsx",
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
      });
    }
  }
});
