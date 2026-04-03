import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { basename, join, resolve, toFileUrl } from "@std/path";
import {
  awaitBackgroundMountStartup,
  awaitForegroundMountExit,
  fuse,
} from "../commands/fuse.ts";
import {
  buildDenoArgs,
  ensureExecShim,
  findMountForPath,
  isAlive,
  mountpointHash,
  readAllMountStates,
  readMountState,
  writeMountState,
} from "../lib/fuse.ts";
import { withEnv } from "./utils.ts";

describe("mountpointHash", () => {
  it("returns a 16-char hex string", async () => {
    const hash = await mountpointHash("/tmp/cf-fuse");
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is deterministic", async () => {
    const a = await mountpointHash("/tmp/cf-fuse");
    const b = await mountpointHash("/tmp/cf-fuse");
    expect(a).toBe(b);
  });

  it("differs for different paths", async () => {
    const a = await mountpointHash("/tmp/cf-fuse-a");
    const b = await mountpointHash("/tmp/cf-fuse-b");
    expect(a).not.toBe(b);
  });
});

describe("mount state operations", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await Deno.makeTempDir({ prefix: "cf-fuse-test-" });
  });

  afterEach(async () => {
    await Deno.remove(tmpDir, { recursive: true });
  });

  it("writeMountState creates file and readMountState reads it back", async () => {
    const entry = {
      pid: 12345,
      mountpoint: "/tmp/test-mount",
      apiUrl: "http://localhost:8000",
      identity: "./fixtures/test-key.pem",
      startedAt: "2026-02-24T00:00:00.000Z",
    };

    const path = await writeMountState(tmpDir, entry);
    expect(path).toContain(tmpDir);
    expect(path).toMatch(/\.json$/);

    const result = await readMountState(tmpDir, "/tmp/test-mount");
    expect(result).not.toBeNull();
    expect(result!.entry).toEqual({
      ...entry,
      identity: resolve(entry.identity),
    });
    expect(result!.path).toBe(path);
  });

  it("readMountState returns null for missing mountpoint", async () => {
    const result = await readMountState(tmpDir, "/nonexistent/path");
    expect(result).toBeNull();
  });

  it("readMountState returns null when state dir does not exist", async () => {
    const result = await readMountState(
      join(tmpDir, "nonexistent"),
      "/tmp/test",
    );
    expect(result).toBeNull();
  });

  it("readAllMountStates returns all entries", async () => {
    await writeMountState(tmpDir, {
      pid: 111,
      mountpoint: "/tmp/mount-a",
      apiUrl: "http://localhost:8000",
      identity: "/tmp/id-a.pem",
      startedAt: "2026-02-24T00:00:00.000Z",
    });
    await writeMountState(tmpDir, {
      pid: 222,
      mountpoint: "/tmp/mount-b",
      apiUrl: "http://localhost:9000",
      identity: "/tmp/id-b.pem",
      startedAt: "2026-02-24T01:00:00.000Z",
    });

    const all = await readAllMountStates(tmpDir);
    expect(all.length).toBe(2);

    const pids = all.map((r) => r.entry.pid).sort();
    expect(pids).toEqual([111, 222]);
  });

  it("readAllMountStates returns empty for nonexistent dir", async () => {
    const all = await readAllMountStates(join(tmpDir, "nope"));
    expect(all).toEqual([]);
  });

  it("readAllMountStates skips corrupt JSON files", async () => {
    // Write a valid entry
    await writeMountState(tmpDir, {
      pid: 333,
      mountpoint: "/tmp/mount-ok",
      apiUrl: "",
      identity: "/tmp/id-ok.pem",
      startedAt: "2026-02-24T00:00:00.000Z",
    });

    // Write a corrupt file
    await Deno.writeTextFile(join(tmpDir, "corrupt.json"), "not json{{{");

    const all = await readAllMountStates(tmpDir);
    expect(all.length).toBe(1);
    expect(all[0].entry.pid).toBe(333);
  });

  it("readAllMountStates ignores non-json files", async () => {
    await writeMountState(tmpDir, {
      pid: 444,
      mountpoint: "/tmp/mount-x",
      apiUrl: "",
      identity: "/tmp/id-x.pem",
      startedAt: "2026-02-24T00:00:00.000Z",
    });
    await Deno.writeTextFile(join(tmpDir, "readme.txt"), "ignore me");

    const all = await readAllMountStates(tmpDir);
    expect(all.length).toBe(1);
  });

  it("writeMountState overwrites existing entry for same mountpoint", async () => {
    const mp = "/tmp/same-mount";
    await writeMountState(tmpDir, {
      pid: 100,
      mountpoint: mp,
      apiUrl: "",
      identity: "/tmp/original.pem",
      startedAt: "2026-02-24T00:00:00.000Z",
    });
    await writeMountState(tmpDir, {
      pid: 200,
      mountpoint: mp,
      apiUrl: "http://new",
      identity: "./relative.pem",
      startedAt: "2026-02-24T01:00:00.000Z",
    });

    const result = await readMountState(tmpDir, mp);
    expect(result!.entry.pid).toBe(200);
    expect(result!.entry.apiUrl).toBe("http://new");
    expect(result!.entry.identity).toBe(resolve("./relative.pem"));

    // Only one file should exist for this mountpoint
    const all = await readAllMountStates(tmpDir);
    expect(all.length).toBe(1);
  });

  it("findMountForPath prefers the longest matching mountpoint", async () => {
    await writeMountState(tmpDir, {
      pid: Deno.pid,
      mountpoint: "/tmp/cf-fuse",
      apiUrl: "http://localhost:8000",
      identity: "/tmp/base.pem",
      startedAt: "2026-02-24T00:00:00.000Z",
    });
    await writeMountState(tmpDir, {
      pid: Deno.pid,
      mountpoint: "/tmp/cf-fuse/nested",
      apiUrl: "http://localhost:9000",
      identity: "/tmp/nested.pem",
      startedAt: "2026-02-24T01:00:00.000Z",
    });

    const match = await findMountForPath(
      "/tmp/cf-fuse/nested/space/pieces/example/result/add.handler",
      tmpDir,
    );

    expect(match).not.toBeNull();
    expect(match!.entry.mountpoint).toBe("/tmp/cf-fuse/nested");
    expect(match!.entry.apiUrl).toBe("http://localhost:9000");
  });

  it("findMountForPath ignores stale entries and removes them", async () => {
    const stalePath = await writeMountState(tmpDir, {
      pid: 1073741824,
      mountpoint: "/tmp/cf-fuse",
      apiUrl: "http://localhost:8000",
      identity: "/tmp/stale.pem",
      startedAt: "2026-02-24T00:00:00.000Z",
    });

    const match = await findMountForPath(
      "/tmp/cf-fuse/space/pieces/example/result/add.handler",
      tmpDir,
    );

    expect(match).toBeNull();
    await expect(Deno.stat(stalePath)).rejects.toThrow();
  });

  it("findMountForPath matches symlinked aliases for the same mountpoint", async () => {
    const realRoot = join(tmpDir, "real");
    const realMount = join(realRoot, "mount");
    const aliasRoot = join(tmpDir, "alias");
    await Deno.mkdir(realMount, { recursive: true });
    await Deno.symlink(realRoot, aliasRoot);

    await writeMountState(tmpDir, {
      pid: Deno.pid,
      mountpoint: realMount,
      apiUrl: "http://localhost:8000",
      identity: "/tmp/base.pem",
      startedAt: "2026-02-24T00:00:00.000Z",
    });

    const match = await findMountForPath(
      join(aliasRoot, "mount/space/pieces/example/result/add.handler"),
      tmpDir,
    );

    expect(match).not.toBeNull();
    expect(match!.entry.mountpoint).toBe(realMount);
  });

  it("readMountState still finds legacy state files after canonical hashing changes", async () => {
    const realRoot = join(tmpDir, "real");
    const realMount = join(realRoot, "mount");
    const aliasRoot = join(tmpDir, "alias");
    const aliasMount = join(aliasRoot, "mount");
    await Deno.mkdir(realMount, { recursive: true });
    await Deno.symlink(realRoot, aliasRoot);

    const legacyKey = new TextEncoder().encode(resolve(aliasMount));
    const legacyHash = await crypto.subtle.digest("SHA-256", legacyKey);
    const legacyPath = join(
      tmpDir,
      `${
        Array.from(new Uint8Array(legacyHash)).map((byte) =>
          byte.toString(16).padStart(2, "0")
        ).join("").slice(0, 16)
      }.json`,
    );
    await Deno.writeTextFile(
      legacyPath,
      JSON.stringify({
        pid: Deno.pid,
        mountpoint: aliasMount,
        apiUrl: "http://localhost:8000",
        identity: "/tmp/base.pem",
        startedAt: "2026-02-24T00:00:00.000Z",
      }),
    );

    const result = await readMountState(tmpDir, aliasMount);

    expect(result).not.toBeNull();
    expect(result!.path).toBe(legacyPath);
    expect(result!.entry.mountpoint).toBe(resolve(aliasMount));
  });

  it("readMountState prefers a live compatible state entry over a stale canonical one", async () => {
    const realRoot = join(tmpDir, "real");
    const realMount = join(realRoot, "mount");
    const aliasRoot = join(tmpDir, "alias");
    const aliasMount = join(aliasRoot, "mount");
    await Deno.mkdir(realMount, { recursive: true });
    await Deno.symlink(realRoot, aliasRoot);

    const canonicalPath = join(
      tmpDir,
      `${await mountpointHash(aliasMount)}.json`,
    );
    await Deno.writeTextFile(
      canonicalPath,
      JSON.stringify({
        pid: 1073741824,
        mountpoint: realMount,
        apiUrl: "http://localhost:8001",
        identity: "/tmp/stale.pem",
        startedAt: "2026-02-24T00:00:00.000Z",
      }),
    );

    const legacyKey = new TextEncoder().encode(resolve(aliasMount));
    const legacyHash = await crypto.subtle.digest("SHA-256", legacyKey);
    const legacyPath = join(
      tmpDir,
      `${
        Array.from(new Uint8Array(legacyHash)).map((byte) =>
          byte.toString(16).padStart(2, "0")
        ).join("").slice(0, 16)
      }.json`,
    );
    await Deno.writeTextFile(
      legacyPath,
      JSON.stringify({
        pid: Deno.pid,
        mountpoint: aliasMount,
        apiUrl: "http://localhost:8000",
        identity: "/tmp/live.pem",
        startedAt: "2026-02-24T00:00:00.000Z",
      }),
    );

    const result = await readMountState(tmpDir, aliasMount);

    expect(result).not.toBeNull();
    expect(result!.path).toBe(legacyPath);
    expect(result!.entry.pid).toBe(Deno.pid);
    expect(result!.entry.apiUrl).toBe("http://localhost:8000");
  });

  it("ensureExecShim creates a repo-rooted shim that targets packages/cli/mod.ts", async () => {
    const stateDir = join(tmpDir, "state");
    const repoRoot = join(tmpDir, "repo");
    const importMetaUrl = toFileUrl(join(repoRoot, "packages/cli/lib/fuse.ts"))
      .href;
    let shimPath = "";
    let shim = "";

    await withEnv("CF_CLI_NAME", "ct", async () => {
      shimPath = await ensureExecShim(stateDir, importMetaUrl);
      shim = await Deno.readTextFile(shimPath);
    });

    expect(shimPath).toBe(join(repoRoot, ".cf", "fuse", "cf-exec"));
    expect(shimPath).not.toBe(join(stateDir, "cf-exec"));
    expect(shim).toContain("#!/usr/bin/env bash");
    expect(shim).toContain("export CF_EXEC_SHEBANG=1");
    expect(shim).toContain("export CF_CLI_NAME=ct");
    expect(shim).toContain('" run --allow-net');
    expect(shim).toContain(join(repoRoot, "packages/cli/mod.ts"));
    expect(shim).toContain('"$@"');
  });

  it("normalizes invalid CF_CLI_NAME values before writing the exec shim", async () => {
    const stateDir = join(tmpDir, "state");
    const repoRoot = join(tmpDir, "repo");
    const importMetaUrl = toFileUrl(join(repoRoot, "packages/cli/lib/fuse.ts"))
      .href;
    let shim = "";

    await withEnv("CF_CLI_NAME", '$(touch "/tmp/pwned")', async () => {
      const shimPath = await ensureExecShim(stateDir, importMetaUrl);
      shim = await Deno.readTextFile(shimPath);
    });

    expect(shim).toContain("export CF_CLI_NAME=cf");
    expect(shim).not.toContain("touch");
    expect(shim).not.toContain("$(");
    expect(shim).not.toContain("`");
  });

  it("ensureExecShim falls back to stateDir when repo root is not writable", async () => {
    const stateDir = join(tmpDir, "state");
    const repoRoot = join(tmpDir, "readonly-repo");
    await Deno.mkdir(join(repoRoot, "packages/cli/lib"), { recursive: true });
    await Deno.chmod(repoRoot, 0o555);

    try {
      const importMetaUrl =
        toFileUrl(join(repoRoot, "packages/cli/lib/fuse.ts"))
          .href;
      const shimPath = await ensureExecShim(stateDir, importMetaUrl);
      const shim = await Deno.readTextFile(shimPath);

      expect(shimPath.startsWith(join(stateDir, "cf-exec-"))).toBe(true);
      expect(shimPath).not.toBe(join(stateDir, "cf-exec"));
      expect(basename(shimPath)).toMatch(/^cf-exec-[0-9a-f]{16}$/);
      expect(shim).toContain("#!/usr/bin/env bash");
      expect(shim).toContain("export CF_EXEC_SHEBANG=1");
      expect(shim).toContain(join(repoRoot, "packages/cli/mod.ts"));
    } finally {
      await Deno.chmod(repoRoot, 0o755);
    }
  });

  it("always removes foreground mount state files before exiting", async () => {
    const statePath = await writeMountState(tmpDir, {
      pid: Deno.pid,
      mountpoint: "/tmp/test-mount",
      apiUrl: "http://localhost:8000",
      identity: "/tmp/test-identity.pem",
      startedAt: "2026-03-17T00:00:00.000Z",
    });

    await expect(
      awaitForegroundMountExit(
        {
          status: Promise.resolve({
            success: false,
            code: 23,
            signal: "SIGTERM",
          }),
        },
        statePath,
        (code: number) => {
          throw new Error(`exit:${code}`);
        },
      ),
    ).rejects.toThrow(/exit:23/);

    await expect(Deno.stat(statePath)).rejects.toThrow();
  });

  it("rejects background mounts that die during startup and removes their state file", async () => {
    const statePath = await writeMountState(tmpDir, {
      pid: 1073741824,
      mountpoint: "/tmp/test-mount",
      apiUrl: "http://localhost:8000",
      identity: "/tmp/test-identity.pem",
      startedAt: "2026-03-17T00:00:00.000Z",
    });

    const removed: string[] = [];
    await expect(
      awaitBackgroundMountStartup(
        1073741824,
        statePath,
        {
          attempts: 1,
          isAlive: () => false,
          removeStateFile: async (path: string) => {
            removed.push(path);
            await Deno.remove(path);
          },
          sleep: () => Promise.resolve(),
        },
      ),
    ).rejects.toThrow(/Background FUSE process exited during startup/i);

    expect(removed).toEqual([statePath]);
    await expect(Deno.stat(statePath)).rejects.toThrow();
  });

  it("allows background mounts that stay alive through the startup window", async () => {
    const statePath = await writeMountState(tmpDir, {
      pid: Deno.pid,
      mountpoint: "/tmp/test-mount",
      apiUrl: "http://localhost:8000",
      identity: "/tmp/test-identity.pem",
      startedAt: "2026-03-17T00:00:00.000Z",
    });

    let checks = 0;
    await expect(
      awaitBackgroundMountStartup(
        Deno.pid,
        statePath,
        {
          attempts: 3,
          isAlive: () => {
            checks++;
            return true;
          },
          sleep: () => Promise.resolve(),
        },
      ),
    ).resolves.toBeUndefined();

    expect(checks).toBe(3);
    await expect(Deno.stat(statePath)).resolves.toBeDefined();
  });
});

describe("fuse help", () => {
  it("mentions executable .handler files and .tool entries", () => {
    const help = fuse.getHelp();
    expect(help).toContain("executable");
    expect(help).toContain("*.handler");
    expect(help).toContain("*.tool");
  });
});

describe("isAlive", () => {
  it("returns true for the current process", () => {
    expect(isAlive(Deno.pid)).toBe(true);
  });

  it("returns false for a bogus PID", () => {
    // PID 2^30 is extremely unlikely to exist
    expect(isAlive(1073741824)).toBe(false);
  });
});

describe("buildDenoArgs", () => {
  it("builds minimal args", () => {
    const args = buildDenoArgs({
      modPath: "/path/to/mod.ts",
      mountpoint: "/mnt",
      apiUrl: "",
      identity: "",
      execCli: "",
    });
    expect(args).toEqual([
      "run",
      "--unstable-ffi",
      "--allow-ffi",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-net",
      "/path/to/mod.ts",
      "/mnt",
    ]);
  });

  it("includes api-url and identity when provided", () => {
    const args = buildDenoArgs({
      modPath: "/mod.ts",
      mountpoint: "/mnt",
      apiUrl: "http://localhost:8000",
      identity: "./key.pem",
      execCli: "/tmp/cf-exec",
    });
    expect(args).toContain("--api-url");
    expect(args).toContain("http://localhost:8000");
    expect(args).toContain("--identity");
    expect(args).toContain("./key.pem");
    expect(args).toContain("--exec-cli");
    expect(args).toContain("/tmp/cf-exec");
  });

  it("omits api-url, identity, and exec-cli when empty", () => {
    const args = buildDenoArgs({
      modPath: "/mod.ts",
      mountpoint: "/mnt",
      apiUrl: "",
      identity: "",
      execCli: "",
    });
    expect(args).not.toContain("--api-url");
    expect(args).not.toContain("--identity");
    expect(args).not.toContain("--exec-cli");
  });
});
