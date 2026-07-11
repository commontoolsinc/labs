import { assertEquals, assertRejects } from "@std/assert";
import type { ACL } from "@commonfabric/memory/acl";
import { ACLManager } from "../src/acl-manager.ts";
import type { Runtime } from "../src/runtime.ts";

const SPACE = "did:key:z6Mk-acl-manager-space";
const ALICE = "did:key:z6Mk-acl-manager-alice";
const BOB = "did:key:z6Mk-acl-manager-bob";
const CAROL = "did:key:z6Mk-acl-manager-carol";

const createHarness = (
  initial: unknown,
  commitResult:
    | { ok: undefined; error?: undefined }
    | { ok?: undefined; error: { name: string; message: string } } = {
      ok: undefined,
    },
) => {
  let written: ACL | undefined;
  let requestedId: string | undefined;
  const txCell = {
    get: () => initial,
    set: (value: ACL) => {
      written = value;
    },
  };
  const cell = {
    sync: () => Promise.resolve(),
    get: () => initial,
    withTx: () => txCell,
  };
  const runtime = {
    storageManager: { synced: () => Promise.resolve() },
    getCellFromLink: (link: { id: string }) => {
      requestedId = link.id;
      return cell;
    },
    editWithRetry: (fn: (tx: unknown) => void) => {
      fn({});
      return Promise.resolve(commitResult);
    },
    idle: () => Promise.resolve(),
  } as unknown as Runtime;
  return {
    manager: new ACLManager(runtime, SPACE),
    written: () => written,
    requestedId: () => requestedId,
  };
};

Deno.test("ACLManager addresses the server's canonical ACL document", async () => {
  const { manager, requestedId } = createHarness({ [ALICE]: "OWNER" });
  await manager.get();
  assertEquals(requestedId(), `of:${SPACE}`);
});

Deno.test("ACLManager returns null for a missing ACL", async () => {
  const { manager } = createHarness(undefined);
  assertEquals(await manager.get(), null);
});

Deno.test("ACLManager rejects malformed and ownerless stored ACLs", async () => {
  for (
    const value of [
      null,
      { [ALICE]: "ADMIN" },
      { [ALICE]: "WRITE" },
      {},
    ]
  ) {
    const { manager } = createHarness(value);
    await assertRejects(
      () => manager.get(),
      Error,
      "malformed or has no concrete OWNER",
    );
  }
});

Deno.test("ACLManager can request space-authorized initialization", async () => {
  const { manager, written } = createHarness(undefined);
  await manager.set(ALICE, "OWNER");
  assertEquals(written(), { [ALICE]: "OWNER" });
});

Deno.test("ACLManager surfaces rejected writes", async () => {
  const { manager } = createHarness(
    { [ALICE]: "OWNER" },
    {
      error: {
        name: "ProtocolError",
        message: "ACL must retain at least one concrete OWNER",
      },
    },
  );
  const error = await assertRejects(
    () => manager.remove(ALICE),
    Error,
    "retain at least one concrete OWNER",
  );
  assertEquals(error.name, "ProtocolError");
});

Deno.test("ACLManager writes a new immutable ACL value", async () => {
  const initial = { [ALICE]: "OWNER" } as const;
  const { manager, written } = createHarness(initial);
  await manager.set(BOB, "WRITE");
  assertEquals(written(), { [ALICE]: "OWNER", [BOB]: "WRITE" });
  assertEquals(initial, { [ALICE]: "OWNER" });
});

Deno.test("ACLManager retry preserves a concurrent ACL update", async () => {
  let current: ACL = { [ALICE]: "OWNER" };
  const writes: ACL[] = [];
  const cell = {
    sync: () => Promise.resolve(),
    get: () => current,
    withTx: () => ({
      get: () => current,
      set: (value: ACL) => writes.push(value),
    }),
  };
  const runtime = {
    storageManager: { synced: () => Promise.resolve() },
    getCellFromLink: () => cell,
    editWithRetry: (fn: (tx: unknown) => void) => {
      fn({ attempt: 1 });
      // The first attempt loses to another ACL writer. A real editWithRetry
      // catches up before invoking the callback again, so expose that winner
      // as the current transactional value for the retry.
      current = { [ALICE]: "OWNER", [CAROL]: "WRITE" };
      fn({ attempt: 2 });
      return Promise.resolve({ ok: undefined });
    },
    idle: () => Promise.resolve(),
  } as unknown as Runtime;

  await new ACLManager(runtime, SPACE).set(BOB, "WRITE");

  assertEquals(writes, [
    { [ALICE]: "OWNER", [BOB]: "WRITE" },
    { [ALICE]: "OWNER", [CAROL]: "WRITE", [BOB]: "WRITE" },
  ]);
});
