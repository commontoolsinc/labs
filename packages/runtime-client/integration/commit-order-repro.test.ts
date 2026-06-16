#!/usr/bin/env -S deno run -A
// WIP repro for the optimistic-write / stale-push clobber investigation.
//
// Needs a local toolshed (memory API) running:
//   bash scripts/start-local-dev.sh
//   API_URL=http://localhost:8000/ deno test -A --no-check \
//     packages/runtime-client/integration/commit-order-repro.test.ts
//
// Emits `[repro] ...` lines and a DIVERGENT check. The richer per-hop
// `[cell-trace]` / `[commit-trace]` output requires the CF_COMMIT_TRACE
// instrumentation, which is NOT on this branch (it was stripped when the
// seq-token change was prepared). Re-add that instrumentation in
// cell-handle.ts / connection.ts / runtime-processor.ts / v2.ts / memory
// client.ts if you want the per-assignment / per-emit tracing back.

import {
  createSession,
  Identity,
  type IdentityCreateConfig,
  type Session,
} from "@commonfabric/identity";
import { env } from "@commonfabric/integration";
import {
  type JSONSchema,
  RuntimeClient,
  type RuntimeClientOptions,
} from "@commonfabric/runtime-client";
import { WebWorkerRuntimeTransport } from "@commonfabric/runtime-client/transports/web-worker";

const { API_URL } = env;
const keyConfig: IdentityCreateConfig = { implementation: "noble" };
const identity = await Identity.fromPassphrase("commit-order repro", keyConfig);

async function createTestSession(): Promise<Session> {
  return await createSession({
    identity,
    spaceName: globalThis.crypto.randomUUID(),
  });
}

async function createRuntimeClient(
  session: Session,
  extraOptions: Partial<RuntimeClientOptions> = {},
): Promise<RuntimeClient> {
  if (session.spaceIdentity && session.spaceName) {
    session.spaceIdentity = await (
      await Identity.fromPassphrase("common user", keyConfig)
    ).derive(session.spaceName, keyConfig);
  }
  const transport = await WebWorkerRuntimeTransport.connect();
  const rt = await RuntimeClient.initialize(transport, {
    apiUrl: new URL(API_URL),
    identity: session.as,
    spaceIdentity: session.spaceIdentity,
    spaceDid: session.space,
    spaceName: session.spaceName,
    ...extraOptions,
  });
  await rt.synced(session.space);
  return rt;
}

const schema = {
  type: "object",
  properties: { x: { type: "string" }, y: { type: "string" } },
} as const satisfies JSONSchema;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test("repro: one client, rapid same-field writes", async () => {
  const session = await createTestSession();
  await using rt = await createRuntimeClient(session);
  const cell = await rt.getCell<{ x: string; y: string }>(
    session.space,
    "commit-order-doc-single",
    schema,
  );
  cell.set({ x: "", y: "" });
  await rt.idle();
  await cell.sync();

  const x = cell.key("x");
  console.error("[repro] --- single-client rapid writes: 'B' then 'Bob' ---");
  x.set("B");
  x.set("Bob");
  await rt.idle();
  await sleep(500);
});

Deno.test("repro: two clients, contended shared doc (input+change vs sibling)", async () => {
  const session = await createTestSession();
  await using rtA = await createRuntimeClient(session);
  await using rtB = await createRuntimeClient(session);
  const cellA = await rtA.getCell<{ x: string; y: string }>(
    session.space,
    "commit-order-doc-shared",
    schema,
  );
  const cellB = await rtB.getCell<{ x: string; y: string }>(
    session.space,
    "commit-order-doc-shared",
    schema,
  );
  cellA.set({ x: "", y: "" });
  await rtA.idle();
  await cellA.sync();
  await cellB.sync();

  const xA = cellA.key("x");
  const xB = cellB.key("x");
  // Tight same-path contention, no settling between rounds: A's two rapid
  // writes (input + change) race B's concurrent write to the SAME field.
  for (let i = 0; i < 60; i++) {
    console.error(`[repro] --- round ${i} ---`);
    xA.set(`B${i}`);
    xA.set(`Bob${i}`);
    xB.set(`other${i}`);
    await sleep(3);
  }
  await Promise.all([rtA.idle(), rtB.idle()]);
  await sleep(800);
});

Deno.test("repro: SINGLE handle subscribed + optimistic set under contention (clobber)", async () => {
  const session = await createTestSession();
  await using rtA = await createRuntimeClient(session);
  await using rtB = await createRuntimeClient(session);
  const a = await rtA.getCell<{ x: string; y: string }>(
    session.space,
    "clobber-doc",
    schema,
  );
  const b = await rtB.getCell<{ x: string; y: string }>(
    session.space,
    "clobber-doc",
    schema,
  );
  await a.set({ x: "init", y: "" });
  await rtA.idle();
  await a.sync();
  await b.sync();

  // Subscribe on the SAME handle we optimistically write to. Record every
  // value the subscriber observes.
  const seen: string[] = [];
  const cancel = a.subscribe((v) => {
    seen.push(JSON.stringify(v));
    console.error("[repro] A subscriber sees:", JSON.stringify(v));
  });

  for (let i = 0; i < 40; i++) {
    console.error(
      `[repro] --- round ${i}: B sets remote, A optimistically sets local on the SUBSCRIBED handle ---`,
    );
    b.set({ x: `remote${i}`, y: "" }); // contention from the other client
    a.set({ x: `local${i}`, y: "" }); // optimistic write on the subscribed handle
    await sleep(15);
  }
  await Promise.all([rtA.idle(), rtB.idle()]);
  await sleep(1000);
  cancel();

  // Divergence check: the subscribed handle's value vs a FRESH sync of the
  // SAME client's runtime (rtA). If they differ, the runtime-client handle is
  // stale relative to its own runtime — the clobber the hypothesis predicts.
  const freshA = await rtA.getCell<{ x: string; y: string }>(
    session.space,
    "clobber-doc",
    schema,
  );
  await freshA.sync();
  console.error("[repro] subscribed handle a.get() =", JSON.stringify(a.get()));
  console.error(
    "[repro] fresh rtA sync (runtime truth) =",
    JSON.stringify(freshA.get()),
  );
  console.error(
    "[repro] DIVERGENT =",
    JSON.stringify(a.get()) !== JSON.stringify(freshA.get()),
  );
});
