import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  FileHarnessCredentialStore,
  type HarnessCredentialStore,
  InMemoryHarnessCredentialStore,
} from "../src/auth/credential-store.ts";
import type { OpenAICodexOAuthCredential } from "../src/auth/types.ts";

const credential = (
  owner: string,
  refreshToken = `refresh-${owner}`,
): OpenAICodexOAuthCredential => ({
  type: "oauth",
  providerId: "openai-codex",
  accessToken: `access-${owner}`,
  refreshToken,
  expiresAt: 4_000_000_000_000,
  accountId: `account-${owner}`,
});

const assertQueuedUpdateCanAbort = async (
  store: HarnessCredentialStore,
): Promise<void> => {
  await store.set("local", "openai-codex", credential("local"));
  let releaseFirst!: () => void;
  const holdFirst = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  const first = store.update("local", "openai-codex", async (current) => {
    markFirstStarted();
    await holdFirst;
    return current;
  });
  await firstStarted;

  let secondUpdaterRan = false;
  const controller = new AbortController();
  const second = store.update(
    "local",
    "openai-codex",
    (current) => {
      secondUpdaterRan = true;
      return current;
    },
    controller.signal,
  );
  controller.abort(new DOMException("queued update canceled", "AbortError"));
  await assertRejects(
    () => second,
    DOMException,
    "queued update canceled",
  );
  assertEquals(secondUpdaterRan, false);

  releaseFirst();
  await first;
  await store.update("local", "openai-codex", (current) => current);
};

Deno.test("in-memory credential store cancels queued mutations", async () => {
  await assertQueuedUpdateCanAbort(new InMemoryHarnessCredentialStore());
});

Deno.test("file credential store cancels queued local lock waits", async () => {
  const root = await Deno.makeTempDir();
  await assertQueuedUpdateCanAbort(
    new FileHarnessCredentialStore({ path: join(root, "auth.json") }),
  );
});

Deno.test("file credential store is owner-isolated, atomic, and private", async () => {
  const root = await Deno.makeTempDir();
  const path = join(root, "harness-home", "auth.json");
  const store = new FileHarnessCredentialStore({ path });

  await Promise.all([
    store.set("loom:user-a", "openai-codex", credential("a")),
    store.set("loom:user-b", "openai-codex", credential("b")),
  ]);

  assertEquals(
    (await store.get("loom:user-a", "openai-codex"))?.accountId,
    "account-a",
  );
  assertEquals(
    (await store.get("loom:user-b", "openai-codex"))?.accountId,
    "account-b",
  );
  assertEquals((await Deno.stat(path)).mode! & 0o777, 0o600);
  assertEquals(
    (await Deno.stat(join(root, "harness-home"))).mode! & 0o777,
    0o700,
  );
  const names = [...Deno.readDirSync(join(root, "harness-home"))].map((e) =>
    e.name
  );
  assertEquals(names.sort(), ["auth.json", "auth.json.lock"]);
});

Deno.test("file credential store serializes mutations across store instances", async () => {
  const root = await Deno.makeTempDir();
  const path = join(root, "auth.json");
  const first = new FileHarnessCredentialStore({ path });
  const second = new FileHarnessCredentialStore({ path });

  await Promise.all([
    first.set("loom:user-a", "openai-codex", credential("a")),
    second.set("loom:user-b", "openai-codex", credential("b")),
  ]);

  assertEquals(
    (await first.get("loom:user-a", "openai-codex"))?.accountId,
    "account-a",
  );
  assertEquals(
    (await first.get("loom:user-b", "openai-codex"))?.accountId,
    "account-b",
  );
});

Deno.test("file credential store preserves prototype-shaped owner keys", async () => {
  const root = await Deno.makeTempDir();
  const store = new FileHarnessCredentialStore({
    path: join(root, "auth.json"),
  });

  await store.set("__proto__", "openai-codex", credential("prototype"));

  assertEquals(
    (await store.get("__proto__", "openai-codex"))?.accountId,
    "account-prototype",
  );
});

Deno.test("file credential store rejects non-private and symlinked homes", async () => {
  if (Deno.build.os === "windows") return;
  const root = await Deno.makeTempDir();
  const publicHome = join(root, "public-home");
  await Deno.mkdir(publicHome, { mode: 0o755 });
  await assertRejects(
    () =>
      new FileHarnessCredentialStore({ path: join(publicHome, "auth.json") })
        .get("local", "openai-codex"),
    Error,
    "private permissions",
  );

  const realHome = join(root, "real-home");
  const linkedHome = join(root, "linked-home");
  await Deno.mkdir(realHome, { mode: 0o700 });
  await Deno.symlink(realHome, linkedHome);
  await assertRejects(
    () =>
      new FileHarnessCredentialStore({ path: join(linkedHome, "auth.json") })
        .get("local", "openai-codex"),
    Error,
    "must not be a symlink",
  );

  const privateHome = join(root, "private-home");
  await Deno.mkdir(privateHome, { mode: 0o700 });
  const publicAuthFile = join(privateHome, "auth.json");
  await Deno.writeTextFile(
    publicAuthFile,
    JSON.stringify({ version: 1, owners: {} }),
    { mode: 0o644 },
  );
  await assertRejects(
    () =>
      new FileHarnessCredentialStore({ path: publicAuthFile })
        .get("local", "openai-codex"),
    Error,
    "file must have private permissions",
  );

  await Deno.remove(publicAuthFile);
  const lockTarget = join(root, "lock-target");
  await Deno.writeTextFile(lockTarget, "");
  await Deno.symlink(lockTarget, `${publicAuthFile}.lock`);
  await assertRejects(
    () =>
      new FileHarnessCredentialStore({ path: publicAuthFile })
        .set("local", "openai-codex", credential("local")),
    Error,
    "lock file must be a regular file",
  );
});

Deno.test("file credential store surfaces malformed storage without overwriting it", async () => {
  const root = await Deno.makeTempDir();
  const path = join(root, "auth.json");
  const store = new FileHarnessCredentialStore({ path });
  await store.set("local", "openai-codex", credential("local"));
  const lastValid = store.lastValidSnapshot();
  await Deno.writeTextFile(path, "{malformed");

  await assertRejects(
    () => store.set("local", "openai-codex", credential("new")),
    Error,
    "failed to read credential store",
  );
  assertEquals(await Deno.readTextFile(path), "{malformed");
  assertEquals(store.lastValidSnapshot(), lastValid);
});

Deno.test("logout deletes only the selected owner/provider entry", async () => {
  const store = new InMemoryHarnessCredentialStore();
  await store.set("loom:user-a", "openai-codex", credential("a"));
  await store.set("loom:user-b", "openai-codex", credential("b"));

  await store.delete("loom:user-a", "openai-codex");

  assertEquals(await store.get("loom:user-a", "openai-codex"), undefined);
  assertEquals(
    (await store.get("loom:user-b", "openai-codex"))?.accountId,
    "account-b",
  );
});
