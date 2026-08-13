import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import {
  FileHarnessProviderSettingsStore,
  resolveHarnessModelProviderPreference,
} from "../src/auth/provider-settings.ts";
import { HarnessControlError } from "../src/control-errors.ts";

describe("provider-settings", () => {
  describe("FileHarnessProviderSettingsStore", () => {
    it("initializes once and preserves the existing file byte for byte", async () => {
      const root = await Deno.makeTempDir();
      const path = join(root, "home", "config.json");
      const store = new FileHarnessProviderSettingsStore({ path });

      expect(await store.initialize("openai-compatible-gateway")).toEqual({
        settings: {
          version: 1,
          modelProvider: "openai-compatible-gateway",
        },
        changed: true,
      });
      const original = await Deno.readTextFile(path);
      expect(await store.initialize("openai-codex")).toEqual({
        settings: {
          version: 1,
          modelProvider: "openai-compatible-gateway",
        },
        changed: false,
      });
      expect(await Deno.readTextFile(path)).toBe(original);
      if (Deno.build.os !== "windows") {
        expect((await Deno.stat(path)).mode! & 0o777).toBe(0o600);
        expect((await Deno.stat(join(root, "home"))).mode! & 0o777).toBe(
          0o700,
        );
      }
    });

    it("serializes concurrent updates across store instances", async () => {
      const root = await Deno.makeTempDir();
      const path = join(root, "config.json");
      const first = new FileHarnessProviderSettingsStore({ path });
      const second = new FileHarnessProviderSettingsStore({ path });

      await Promise.all([
        first.set("openai-codex"),
        second.set("openai-compatible-gateway"),
      ]);

      const state = await first.inspect();
      expect(state.state).toBe("configured");
      if (state.state === "configured") {
        expect([
          "openai-codex",
          "openai-compatible-gateway",
        ]).toContain(state.settings.modelProvider);
      }
      expect(JSON.parse(await Deno.readTextFile(path)).version).toBe(1);
    });

    it("reports corrupt and unsupported documents without overwriting them", async () => {
      const root = await Deno.makeTempDir();
      const path = join(root, "config.json");
      const store = new FileHarnessProviderSettingsStore({ path });
      for (
        const document of [
          "{broken",
          '{"version":99,"modelProvider":"openai-codex"}',
        ]
      ) {
        await Deno.writeTextFile(path, document, { mode: 0o600 });
        const state = await store.inspect();
        expect(["invalid", "unsupported-version"]).toContain(state.state);
        await expect(store.set("openai-codex")).rejects.toBeInstanceOf(
          HarnessControlError,
        );
        expect(await Deno.readTextFile(path)).toBe(document);
      }
    });

    it("rejects public homes, target symlinks, and lock symlinks", async () => {
      if (Deno.build.os === "windows") return;
      const root = await Deno.makeTempDir();
      const publicHome = join(root, "public");
      await Deno.mkdir(publicHome, { mode: 0o755 });
      const publicStore = new FileHarnessProviderSettingsStore({
        path: join(publicHome, "config.json"),
      });
      expect((await publicStore.inspect()).state).toBe("unreadable");

      const privateHome = join(root, "private");
      await Deno.mkdir(privateHome, { mode: 0o700 });
      const target = join(root, "target");
      await Deno.writeTextFile(target, "{}");
      const path = join(privateHome, "config.json");
      await Deno.symlink(target, path);
      expect(
        (await new FileHarnessProviderSettingsStore({ path }).inspect()).state,
      )
        .toBe("unreadable");

      await Deno.remove(path);
      await Deno.symlink(target, `${path}.lock`);
      await expect(
        new FileHarnessProviderSettingsStore({ path }).set("openai-codex"),
      ).rejects.toThrow("lock file must be a regular file");
    });

    it("cancels a queued mutation before it writes", async () => {
      const root = await Deno.makeTempDir();
      const store = new FileHarnessProviderSettingsStore({
        path: join(root, "config.json"),
      });
      let releaseFirst!: () => void;
      const firstHeld = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let markLockStarted!: () => void;
      const lockStarted = new Promise<void>((resolve) => {
        markLockStarted = resolve;
      });
      const lockPath = `${store.path}.lock`;
      const lock = await Deno.open(lockPath, {
        create: true,
        read: true,
        write: true,
        mode: 0o600,
      });
      await lock.lock(true);
      const observed = new FileHarnessProviderSettingsStore({
        path: store.path,
        onLockAcquisitionStarted: markLockStarted,
      });
      const controller = new AbortController();
      const pending = observed.set("openai-codex", controller.signal);
      await lockStarted;
      const reason = new DOMException("settings update canceled", "AbortError");
      controller.abort(reason);
      await expect(pending).rejects.toBe(reason);
      await lock.unlock();
      lock.close();
      releaseFirst();
      await firstHeld;
      expect((await store.inspect()).state).toBe("missing");
    });
  });

  describe("resolveHarnessModelProviderPreference()", () => {
    it("applies explicit, environment, persistent, and default precedence", async () => {
      const configured = {
        inspect: () =>
          Promise.resolve({
            state: "configured" as const,
            settings: {
              version: 1 as const,
              modelProvider: "openai-codex" as const,
            },
          }),
      };
      expect(
        await resolveHarnessModelProviderPreference({
          store: configured,
          explicit: "openai-compatible-gateway",
          environment: "openai-codex",
        }),
      ).toEqual({
        provider: "openai-compatible-gateway",
        source: "explicit",
      });
      expect(
        await resolveHarnessModelProviderPreference({
          store: configured,
          environment: "openai-compatible-gateway",
        }),
      ).toEqual({
        provider: "openai-compatible-gateway",
        source: "environment",
      });
      expect(await resolveHarnessModelProviderPreference({ store: configured }))
        .toEqual({ provider: "openai-codex", source: "persistent" });
      expect(
        await resolveHarnessModelProviderPreference({
          store: { inspect: () => Promise.resolve({ state: "missing" }) },
        }),
      ).toEqual({
        provider: "openai-compatible-gateway",
        source: "default",
      });
    });

    it("requires persistent configuration in strict mode", async () => {
      const resolution = resolveHarnessModelProviderPreference({
        store: { inspect: () => Promise.resolve({ state: "missing" }) },
        strict: true,
      });
      await expect(resolution).rejects.toMatchObject({
        code: "provider-configuration-required",
      });
    });
  });
});
