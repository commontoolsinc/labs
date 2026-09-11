import { AgentFabricTarget } from "@commonfabric/agents-connector/fabric";
import { createSession } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import { Runtime } from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { assertEquals, assertRejects } from "@std/assert";
import { fromFileUrl } from "@std/path";
import type { Cell } from "../../../../runner/src/builder/types.ts";
import { bindCommandProducers } from "../src/command-producers.ts";
import { defaultDebugPatternLocation } from "../src/debug-view.ts";
import {
  identity,
  materializeCell,
  renderedNodes,
  renderedText,
} from "./debug_view_support.ts";

const FIXTURE_ROOT = defaultDebugPatternLocation().rootPath;

function fixturePath(name: string): string {
  return fromFileUrl(new URL(`./fixtures/${name}`, import.meta.url));
}

Deno.test("a configured producer piece sends commands through its own protected queue", async () => {
  const session = await createSession({
    identity,
    spaceName: `command-producer-${crypto.randomUUID()}`,
  });
  const storageManager = StorageManager.emulate({ as: session.as });
  let actingPrincipal = session.as.did();
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    trustSnapshotProvider: () => ({
      id: `principal:${actingPrincipal}`,
      actingPrincipal,
    }),
  });
  try {
    const manager = new PiecesController(session, runtime);
    await manager.synced();
    const target = await AgentFabricTarget.open({
      runtime,
      spaceDid: session.space,
      ownerDid: session.as.did(),
    });
    const program = await resolveLocalProgram(
      (resolver) => manager.runtime.harness.resolve(resolver),
      { main: fixturePath("command-producer.tsx"), root: FIXTURE_ROOT },
    );
    const piece = await manager.create(program, { input: {} });
    assertEquals(target.commandsAreBound(), false);

    const bound = await bindCommandProducers(manager, target, [
      { id: "fixture", piece: piece.id },
    ]);

    assertEquals(bound.map((producer) => producer.id), ["fixture"]);
    assertEquals(bound[0].piece, piece.id);
    assertEquals(target.producerCommandCellIds(), {
      fixture: bound[0].commandCellId,
    });
    assertEquals(target.commandsAreBound(), true);
    assertEquals(await target.pollCommands(), []);

    // The queue is now the piece's `commands` input, and its handler is the
    // queue's verified writer.
    await runtime.settled();
    const result = await piece.result.get() as Record<string, unknown>;
    const draft = renderedNodes(result["$UI"]).find((node) =>
      node.name === "cf-textarea"
    )?.props?.["$value"] as Cell<string>;
    const draftTx = runtime.edit();
    draft.withTx(draftTx).set(JSON.stringify({ type: "start", id: "one" }));
    const draftCommit = await draftTx.commit();
    if (draftCommit.error) throw draftCommit.error;
    await runtime.settled();
    const sendButton = renderedNodes(result["$UI"]).find((node) =>
      node.name === "cf-button" && renderedText(node.children) === "Send"
    );
    const send = materializeCell(sendButton?.props?.onClick) as {
      send: (event: unknown) => void;
    };
    assertEquals(typeof send.send, "function");

    actingPrincipal = "did:key:someone-else";
    send.send({});
    await runtime.settled();
    assertEquals(await target.pollCommands(), []);

    actingPrincipal = session.as.did();
    send.send({});
    await runtime.settled();
    assertEquals(await target.pollCommands(), [
      JSON.stringify({ type: "start", id: "one" }),
    ]);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});

Deno.test("a producer whose pattern declares no command authorization is refused", async () => {
  const session = await createSession({
    identity,
    spaceName: `command-producer-unauthorized-${crypto.randomUUID()}`,
  });
  const storageManager = StorageManager.emulate({ as: session.as });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });
  try {
    const manager = new PiecesController(session, runtime);
    await manager.synced();
    const target = await AgentFabricTarget.open({
      runtime,
      spaceDid: session.space,
      ownerDid: session.as.did(),
    });
    const program = await resolveLocalProgram(
      (resolver) => manager.runtime.harness.resolve(resolver),
      {
        main: fixturePath("debug-view-without-command-authorization.tsx"),
        root: FIXTURE_ROOT,
      },
    );
    const piece = await manager.create(program, {
      input: { ownerDid: session.as.did() },
    });

    await assertRejects(
      () =>
        bindCommandProducers(manager, target, [
          { id: "silent", piece: piece.id },
        ]),
      Error,
      "command producer silent declares no verified command writer authorization",
    );
    assertEquals(target.commandsAreBound(), false);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
});
