/**
 *   deno run -A --no-check --config deno.jsonc \
 *     perf-harness/settle-yield/seed-room.ts --api-url http://localhost:8037/ \
 *     --members 12 --messages 30 --salt s1 --out <room.json> --key <starter.key>
 *
 * Seeds a fabrichat room on a running toolshed: a manager (the fabrichat-spaces
 * fixture) creates a group room, each member gets a profile of their own
 * selected as their home profile, joins the roster, and the members post
 * messages round-robin with the send gesture. Writes a fixture JSON and the
 * starter's key file for `cf piece render`.
 */
import { parseArgs } from "@std/cli/parse-args";
import { join } from "@std/path";
import { Identity } from "@commonfabric/identity";
import { createTestSpace } from "@commonfabric/integration";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import type { Cell, MemorySpace } from "@commonfabric/runner";
import {
  markRendererTrustedEvent,
  reviewedActionProvenance,
} from "@commonfabric/runner/cfc";
import { setCfcImplementationIdentity } from "@commonfabric/runner/cfc/trust-authority";
import { decode } from "@commonfabric/utils/encoding";
import {
  initializePiecesController,
  PieceController,
  type PiecesController,
} from "../../packages/patterns/integration/pieces-controller.ts";

const REPO = new URL("../../", import.meta.url).pathname;
const flags = parseArgs(Deno.args, {
  string: ["api-url", "members", "messages", "out", "key", "salt"],
});
const apiUrl = new URL(flags["api-url"]!);
const memberCount = Number(flags.members ?? "12");
const messageCount = Number(flags.messages ?? "30");
const salt = flags.salt ?? "a";
const out = flags.out!;
const keyPath = flags.key!;

const START_ACTION = { surface: "ChatStartSurface", action: "ChatStart" };
const SEND_ACTION = { surface: "ChatSendSurface", action: "ChatSend" };
const OWN_PROFILE_WRITER = "room-perf-own-profile";
const OWN_PROFILE_SCHEMA = {
  type: "object",
  properties: { name: { type: "string" } },
  ifc: {
    addIntegrity: [{
      kind: "represents-principal",
      subject: { __ctCurrentPrincipal: true },
    }],
    ownerPrincipal: { __ctCurrentPrincipal: true },
    writeAuthorizedBy: [OWN_PROFILE_WRITER],
  },
} as never;

const log = (message: string) => console.error(`[seed-room] ${message}`);

async function idle(cc: PiecesController) {
  await cc.runtime.idle();
  await cc.synced();
}

async function send(
  cc: PiecesController,
  target: Cell<any>,
  handler: string,
  event: Record<string, unknown>,
  trusted?: { surface: string; action: string },
) {
  let eventValue: unknown = event;
  if (trusted) {
    eventValue = {
      type: "click",
      ...event,
      provenance: reviewedActionProvenance("dom", trusted),
    };
    markRendererTrustedEvent(eventValue as object);
  }
  const { error } = await cc.runtime.editWithRetry((tx) => {
    target.key(handler as never).withTx(tx).send(eventValue as never);
  });
  if (error) throw new Error(`send ${handler} failed: ${error.message}`);
  await idle(cc);
}

async function createOwnProfile(cc: PiecesController, name: string) {
  const runtime = cc.runtime;
  // As the profile-create surface does: a profile's space grants anyone WRITE.
  const space = await runtime.createSpace({ grants: { "*": "WRITE" } });
  const tx = runtime.edit();
  setCfcImplementationIdentity(tx, {
    kind: "builtin",
    builtinId: OWN_PROFILE_WRITER,
  });
  const profile = runtime.getCell(space, "own profile", OWN_PROFILE_SCHEMA, tx);
  profile.set({ name } as never);
  log(`  own profile: committing`);
  const { error } = await tx.commit().settled;
  if (error) throw error;
  log(`  own profile: committed, idling`);
  await idle(cc);
  return profile;
}

async function selectProfile(cc: PiecesController, profile: Cell<any>) {
  const runtime = cc.runtime;
  const tx = runtime.edit();
  const home = runtime.getHomeSpaceCell(tx);
  const defaultPattern = runtime.getCell(
    home.space,
    "room-perf-profile-home",
    undefined,
    tx,
  );
  defaultPattern.key("profiles").set([profile]);
  defaultPattern.key("defaultProfile").set({ profile });
  home.asSchema<{ defaultPattern: Cell<unknown> }>({ type: "object" })
    .key("defaultPattern").set(defaultPattern);
  const { error } = await tx.commit().settled;
  if (error) throw error;
  await idle(cc);
}

/** Resolves once `cell` reads a value `ok` accepts, through its sink. */
function until(
  cell: Cell<any>,
  ok: (value: unknown) => boolean,
  label: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let done = false;
    // The timer's callback closes over this before the sink assigns it.
    // deno-lint-ignore prefer-const
    let cancel: (() => void) | undefined;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      cancel?.();
      reject(new Error(`${label} never became true`));
    }, 120_000);
    cancel = cell.sink((value: unknown) => {
      if (done || !ok(value)) return;
      done = true;
      clearTimeout(timer);
      queueMicrotask(() => cancel?.());
      resolve();
    });
    if (done) cancel();
  });
}

async function roomResultFor(
  cc: PiecesController,
  room: { id: string; space: string },
): Promise<Cell<any>> {
  const cell = await (await cc.getPieceCell(
    cc.runtime.getCellFromEntityId(room.space as MemorySpace, room.id),
    true,
  )).sync();
  const piece = new PieceController(cc, cell);
  const schema = (await piece.getPattern() as { resultSchema?: unknown })
    .resultSchema;
  const raw = cc.getResult(cell);
  return schema !== undefined ? raw.asSchema(schema as never) : raw;
}

const started = performance.now();
const starter = await Identity.fromPassphrase(`room-perf starter ${salt}`, {
  implementation: "noble",
});
const members: Identity[] = [];
for (let i = 0; i < memberCount; i++) {
  members.push(
    await Identity.fromPassphrase(`room-perf member ${i} ${salt}`, {
      implementation: "noble",
    }),
  );
}
await Deno.writeTextFile(keyPath, decode(starter.toPkcs8()));

const grants = Object.fromEntries(members.map((m) => [m.did(), "WRITE"]));
const harnessSpace = await createTestSpace(starter, { apiUrl, grants });
log(`harness space ${harnessSpace}`);
const cc = await initializePiecesController({
  space: harnessSpace,
  apiUrl,
  identity: starter,
});
await cc.ensureDefaultPattern();
const program = await resolveLocalProgram(
  (resolver) => cc.runtime.harness.resolve(resolver),
  {
    main: join(
      REPO,
      "packages/patterns/integration/fixtures/fabrichat-spaces/main.tsx",
    ),
    root: join(REPO, "packages/patterns"),
  },
);
const manager = await cc.create(program, { start: true });
const managerSchema = (await manager.getPattern() as { resultSchema?: unknown })
  .resultSchema;
const managerResult = cc.getResult(manager.getCell()).asSchema(
  managerSchema as never,
);
await idle(cc);
log(
  `manager ${manager.id} created in ${
    Math.round(performance.now() - started)
  }ms`,
);

await send(cc, managerResult, "createGroup", {
  requestId: "g-perf",
  title: "Perf room",
  members: members.map((m) => m.did()),
}, START_ACTION);
const status = managerResult.key("requests").key("g-perf").key("status").get();
if (status !== "done") throw new Error(`createGroup status ${String(status)}`);
await managerResult.pull();
const roomLink = managerResult.key("requests").key("g-perf").key("entry").key(
  "room",
).resolveAsCell().getAsNormalizedFullLink();
const room = { id: roomLink.id, space: roomLink.space as string };
log(`room ${room.id} in ${room.space}`);
await roomResultFor(cc, room);

const controllers: PiecesController[] = [];
const rooms: Cell<any>[] = [];
for (let i = 0; i < memberCount; i++) {
  const member = members[i];
  const ccM = await initializePiecesController({
    space: room.space as MemorySpace,
    apiUrl,
    identity: member,
  });
  controllers.push(ccM);
  log(
    `member ${i + 1}: controller ready (${
      Math.round(performance.now() - started)
    }ms)`,
  );
  const profile = await createOwnProfile(ccM, `Member ${i + 1}`);
  log(`member ${i + 1}: own profile created`);
  await selectProfile(ccM, profile);
  log(`member ${i + 1}: profile selected`);
  const result = await roomResultFor(ccM, room);
  log(`member ${i + 1}: room result loaded`);
  rooms.push(result);
  await until(result.key("canSend"), (v) => v === true, `member ${i} canSend`);
  log(`member ${i + 1}: canSend`);
  await send(ccM, result, "addParticipant", { profile: profile.getAsLink() });
  log(`member ${i + 1} joined (${Math.round(performance.now() - started)}ms)`);
}

for (let j = 0; j < messageCount; j++) {
  const i = j % memberCount;
  await send(controllers[i], rooms[i], "sendMessage", {
    requestId: `m-${j}`,
    target: {
      value: `Message ${j + 1} from member ${i + 1}: ${
        "lorem ipsum dolor sit amet ".repeat(1 + (j % 4))
      }`,
    },
  }, SEND_ACTION);
  if ((j + 1) % 10 === 0 || j + 1 === messageCount) {
    log(
      `${j + 1}/${messageCount} messages (${
        Math.round(performance.now() - started)
      }ms)`,
    );
  }
}
const count = rooms[0].key("messages").key("count").get();
log(`room reports ${String(count)} messages`);

await Deno.writeTextFile(
  out,
  JSON.stringify(
    {
      apiUrl: apiUrl.href,
      harnessSpace,
      managerId: manager.id,
      roomSpace: room.space,
      roomId: room.id,
      starterDid: starter.did(),
      keyPath,
      members: memberCount,
      messages: messageCount,
      salt,
    },
    null,
    2,
  ),
);
for (const ccM of controllers) await ccM.dispose();
await cc.dispose();
log(`done in ${Math.round(performance.now() - started)}ms`);
