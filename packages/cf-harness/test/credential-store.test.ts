import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  FileHarnessCredentialStore,
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
  assertEquals(names, ["auth.json"]);
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
