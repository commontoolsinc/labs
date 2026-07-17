import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { basename, join, resolve, toFileUrl } from "@std/path";
import {
  awaitBackgroundMountStartup,
  awaitForegroundMountExit,
  buildMountStatusRows,
  childStatusPathForStatePath,
  type ChildStatusWatcher,
  formatMountStatusTable,
  fuse,
  isFuseProcessCommand,
  mountStatusHeader,
} from "../commands/fuse.ts";
import {
  buildBackgroundSupervisorDenoArgs,
  buildDenoArgs,
  buildFuseBinaryArgs,
  buildFuseChildDenoArgs,
  ensureExecShim,
  findMountForPath,
  isAlive,
  isMountStateAlive,
  mountpointHash,
  readAllMountStates,
  readMountState,
  writeMountState,
} from "../lib/fuse.ts";
import {
  buildFuseChildCommand,
  cleanupFuseChild,
  parseSupervisorArgs,
  recordFuseChildPid,
  runFuseSupervisor,
  supervisorHelp,
} from "../lib/fuse-supervisor.ts";
import { writeFailedSupervisorStartupStatus } from "../../fuse/mod.ts";
import { defer, type Deferred } from "@commonfabric/utils/defer";
import { withEnv } from "./utils.ts";

/**
 * A stand-in for the spawned supervisor whose exit the test decides.
 * `awaitBackgroundMountStartup` only ever reads `pid` and `status`.
 */
function fakeSupervisor(pid: number = Deno.pid) {
  const exited = defer<Deno.CommandStatus>();
  return {
    process: { pid, status: exited.promise },
    exit: (code = 1) =>
      exited.resolve({ success: code === 0, code, signal: null }),
  };
}

/**
 * A stand-in for the state-directory watcher, matching the parts of
 * `Deno.watchFs` this wait depends on: events are buffered from creation, so a
 * test can queue one before the wait starts iterating; leaving the event loop
 * closes the watcher; and closing an already-closed watcher reports a bad
 * resource.
 */
function fakeStatusWatcher(): ChildStatusWatcher & {
  emit(): void;
  closed: boolean;
} {
  const buffered: unknown[] = [];
  let wake: Deferred<void> | null = null;
  const watcher = {
    closed: false,
    emit() {
      buffered.push({ kind: "modify" });
      wake?.resolve();
      wake = null;
    },
    close() {
      if (watcher.closed) throw new Deno.errors.BadResource("Bad resource ID");
      watcher.closed = true;
      wake?.resolve();
      wake = null;
    },
    async *[Symbol.asyncIterator]() {
      try {
        while (true) {
          while (buffered.length > 0) yield buffered.shift();
          if (watcher.closed) return;
          wake = defer<void>();
          await wake.promise;
        }
      } finally {
        watcher.closed = true;
      }
    },
  };
  return watcher;
}

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

    shimPath = await ensureExecShim(stateDir, importMetaUrl);
    shim = await Deno.readTextFile(shimPath);

    expect(shimPath).toBe(join(repoRoot, ".cf", "fuse", "cf-exec"));
    expect(shimPath).not.toBe(join(stateDir, "cf-exec"));
    expect(shim).toContain("#!/usr/bin/env bash");
    expect(shim).toContain("export CF_EXEC_SHEBANG=1");
    expect(shim).toContain("export CF_CLI_NAME=cf");
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
      childPid: 321,
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
    const childStatusPath = childStatusPathForStatePath(statePath);
    const supervisor = fakeSupervisor(1073741824);
    const watcher = fakeStatusWatcher();
    const removed: string[] = [];

    const startup = awaitBackgroundMountStartup(
      supervisor.process,
      statePath,
      {
        childStatusPath,
        childStatusToken: "token-1",
        mountpoint: "/tmp/test-mount",
        isAlive: () => false,
        readTextFile: () => Promise.reject(new Deno.errors.NotFound()),
        watchStatus: () => watcher,
        removeStateFile: async (path: string) => {
          removed.push(path);
          await Deno.remove(path);
        },
      },
    );
    supervisor.exit(1);

    await expect(startup).rejects.toThrow(
      /Background FUSE process exited during startup/i,
    );
    expect(removed).toEqual([statePath]);
    expect(watcher.closed).toBe(true);
    await expect(Deno.stat(statePath)).rejects.toThrow();
  });

  it("does not report readiness for a child that stays alive without reporting mounted", async () => {
    const statePath = await writeMountState(tmpDir, {
      pid: Deno.pid,
      childPid: 321,
      mountpoint: "/tmp/test-mount",
      apiUrl: "http://localhost:8000",
      identity: "/tmp/test-identity.pem",
      startedAt: "2026-03-17T00:00:00.000Z",
    });
    const childStatusPath = childStatusPathForStatePath(statePath);
    const supervisor = fakeSupervisor();
    const watcher = fakeStatusWatcher();
    const removed: string[] = [];
    let reads = 0;

    // The child is alive and reporting, but never reports mounted. Liveness
    // alone must not be read as readiness, so the process exiting is the only
    // way out. Each read arms the next wake-up, so the wait is observed
    // staying open across several of them before the exit ends it.
    const startup = awaitBackgroundMountStartup(supervisor.process, statePath, {
      childStatusPath,
      childStatusToken: "token-1",
      mountpoint: "/tmp/test-mount",
      isAlive: () => true,
      readTextFile: () => {
        reads++;
        if (reads < 3) queueMicrotask(() => watcher.emit());
        else supervisor.exit(1);
        return Promise.resolve(JSON.stringify({
          state: "starting",
          pid: 321,
          mountpoint: "/tmp/test-mount",
          token: "token-1",
          updatedAt: "2026-03-17T00:00:00.000Z",
        }));
      },
      watchStatus: () => watcher,
      removeStateFile: async (path: string) => {
        removed.push(path);
        await Deno.remove(path);
      },
    });

    await expect(startup).rejects.toThrow(
      /Background FUSE process exited during startup/i,
    );
    expect(reads).toBe(3);
    expect(removed).toEqual([statePath]);
  });

  it("waits for the child to report mounted, however long that takes", async () => {
    const statePath = await writeMountState(tmpDir, {
      pid: Deno.pid,
      childPid: 321,
      mountpoint: "/tmp/test-mount",
      apiUrl: "http://localhost:8000",
      identity: "/tmp/test-identity.pem",
      startedAt: "2026-03-17T00:00:00.000Z",
    });
    const childStatusPath = childStatusPathForStatePath(statePath);
    const supervisor = fakeSupervisor();
    const watcher = fakeStatusWatcher();
    // A slow startup: the child heartbeats far more times than any past
    // attempt ceiling allowed before it finally reports mounted. Each read
    // arms the next wake-up, so these are consumed one at a time rather than
    // collapsing into a single buffered batch.
    const heartbeatsBeforeMounted = 500;
    let reads = 0;

    const startup = awaitBackgroundMountStartup(supervisor.process, statePath, {
      childStatusPath,
      childStatusToken: "token-1",
      mountpoint: "/tmp/test-mount",
      isAlive: () => true,
      readTextFile: () => {
        reads++;
        const ready = reads > heartbeatsBeforeMounted;
        if (!ready) queueMicrotask(() => watcher.emit());
        return Promise.resolve(JSON.stringify({
          state: ready ? "mounted" : "starting",
          pid: 321,
          mountpoint: "/tmp/test-mount",
          token: "token-1",
          updatedAt: "2026-03-17T00:00:00.000Z",
        }));
      },
      watchStatus: () => watcher,
    });

    await expect(startup).resolves.toBeUndefined();
    expect(reads).toBe(heartbeatsBeforeMounted + 1);
    expect(watcher.closed).toBe(true);
    await expect(Deno.stat(statePath)).resolves.toBeDefined();
  });

  it("reports readiness from a mounted status already written before the wait began", async () => {
    const statePath = await writeMountState(tmpDir, {
      pid: Deno.pid,
      childPid: 321,
      mountpoint: "/tmp/test-mount",
      apiUrl: "http://localhost:8000",
      identity: "/tmp/test-identity.pem",
      startedAt: "2026-03-17T00:00:00.000Z",
    });
    const childStatusPath = childStatusPathForStatePath(statePath);
    const watcher = fakeStatusWatcher();

    // The child can win the race and report mounted before the CLI starts
    // watching; the read that follows the watch has to catch that.
    await expect(
      awaitBackgroundMountStartup(fakeSupervisor().process, statePath, {
        childStatusPath,
        childStatusToken: "token-1",
        mountpoint: "/tmp/test-mount",
        isAlive: () => true,
        readTextFile: () =>
          Promise.resolve(JSON.stringify({
            state: "mounted",
            pid: 321,
            mountpoint: "/tmp/test-mount",
            token: "token-1",
            updatedAt: "2026-03-17T00:00:00.000Z",
          })),
        watchStatus: () => watcher,
      }),
    ).resolves.toBeUndefined();

    expect(watcher.closed).toBe(true);
    await expect(Deno.stat(statePath)).resolves.toBeDefined();
  });

  it("reports readiness from a real filesystem watch of the state directory", async () => {
    // A fake watcher cannot stand in for `Deno.watchFs` here. The real one
    // closes itself when the wait leaves its event loop, so this is the only
    // test that covers what the background mount command actually wires up.
    const statePath = await writeMountState(tmpDir, {
      pid: Deno.pid,
      childPid: Deno.pid,
      mountpoint: "/tmp/test-mount",
      apiUrl: "http://localhost:8000",
      identity: "/tmp/test-identity.pem",
      startedAt: "2026-03-17T00:00:00.000Z",
    });
    const childStatusPath = childStatusPathForStatePath(statePath);
    const firstReadSettled = defer<void>();
    let reads = 0;

    const startup = awaitBackgroundMountStartup(
      fakeSupervisor().process,
      statePath,
      {
        childStatusPath,
        childStatusToken: "token-1",
        mountpoint: "/tmp/test-mount",
        readTextFile: async (path: string) => {
          reads++;
          try {
            return await Deno.readTextFile(path);
          } finally {
            if (reads === 1) firstReadSettled.resolve();
          }
        },
      },
    );

    // Let the read that follows the watch miss the file, so readiness can only
    // arrive as a real filesystem event rather than from that first read.
    await firstReadSettled.promise;
    await Deno.writeTextFile(
      childStatusPath,
      JSON.stringify({
        state: "mounted",
        pid: Deno.pid,
        mountpoint: "/tmp/test-mount",
        token: "token-1",
        updatedAt: "2026-03-17T00:00:00.000Z",
      }),
    );

    await expect(startup).resolves.toBeUndefined();
    expect(reads).toBeGreaterThan(1);
  });

  it("rejects background mounts when child exits after reporting mounted", async () => {
    const statePath = await writeMountState(tmpDir, {
      pid: Deno.pid,
      childPid: 321,
      mountpoint: "/tmp/test-mount",
      apiUrl: "http://localhost:8000",
      identity: "/tmp/test-identity.pem",
      startedAt: "2026-03-17T00:00:00.000Z",
    });
    const childStatusPath = childStatusPathForStatePath(statePath);
    const removed: string[] = [];

    await expect(
      awaitBackgroundMountStartup(fakeSupervisor().process, statePath, {
        childStatusPath,
        childStatusToken: "token-1",
        mountpoint: "/tmp/test-mount",
        isAlive: (pid) => pid !== 321,
        readTextFile: () =>
          Promise.resolve(JSON.stringify({
            state: "mounted",
            pid: 321,
            mountpoint: "/tmp/test-mount",
            token: "token-1",
            updatedAt: "2026-03-17T00:00:00.000Z",
          })),
        watchStatus: () => fakeStatusWatcher(),
        removeStateFile: async (path: string) => {
          removed.push(path);
          await Deno.remove(path).catch(() => undefined);
        },
      }),
    ).rejects.toThrow(/child exited after reporting mounted/i);

    expect(removed).toEqual([statePath, childStatusPath]);
    await expect(Deno.stat(statePath)).rejects.toThrow();
  });

  it("never reports readiness from a mounted status belonging to another startup attempt", async () => {
    const statePath = await writeMountState(tmpDir, {
      pid: Deno.pid,
      childPid: 321,
      mountpoint: "/tmp/test-mount",
      apiUrl: "http://localhost:8000",
      identity: "/tmp/test-identity.pem",
      startedAt: "2026-03-17T00:00:00.000Z",
    });
    const childStatusPath = childStatusPathForStatePath(statePath);
    const supervisor = fakeSupervisor();
    const watcher = fakeStatusWatcher();
    const removed: string[] = [];

    const startup = awaitBackgroundMountStartup(supervisor.process, statePath, {
      childStatusPath,
      childStatusToken: "token-1",
      mountpoint: "/tmp/test-mount",
      isAlive: () => true,
      readTextFile: () =>
        Promise.resolve(JSON.stringify({
          state: "mounted",
          pid: 321,
          mountpoint: "/tmp/test-mount",
          token: "stale-token",
          updatedAt: "2026-03-17T00:00:00.000Z",
        })),
      watchStatus: () => watcher,
      removeStateFile: async (path: string) => {
        removed.push(path);
        await Deno.remove(path);
      },
    });
    watcher.emit();
    supervisor.exit(1);

    await expect(startup).rejects.toThrow(
      /Background FUSE process exited during startup/i,
    );
    expect(removed).toEqual([statePath]);
  });

  it("keeps waiting through a half-written child status file", async () => {
    const statePath = await writeMountState(tmpDir, {
      pid: Deno.pid,
      childPid: 321,
      mountpoint: "/tmp/test-mount",
      apiUrl: "http://localhost:8000",
      identity: "/tmp/test-identity.pem",
      startedAt: "2026-03-17T00:00:00.000Z",
    });
    const childStatusPath = childStatusPathForStatePath(statePath);
    const watcher = fakeStatusWatcher();
    let text = "{not-json";

    const startup = awaitBackgroundMountStartup(
      fakeSupervisor().process,
      statePath,
      {
        childStatusPath,
        childStatusToken: "token-1",
        mountpoint: "/tmp/test-mount",
        isAlive: () => true,
        readTextFile: () => Promise.resolve(text),
        watchStatus: () => watcher,
      },
    );

    // Unreadable content is "not yet", not a verdict: the next write decides.
    watcher.emit();
    text = JSON.stringify({
      state: "mounted",
      pid: 321,
      mountpoint: "/tmp/test-mount",
      token: "token-1",
      updatedAt: "2026-03-17T00:00:00.000Z",
    });
    watcher.emit();

    await expect(startup).resolves.toBeUndefined();
  });

  it("does not read child status sidecars as mount state entries", async () => {
    const statePath = await writeMountState(tmpDir, {
      pid: Deno.pid,
      childPid: 321,
      mountpoint: "/tmp/test-mount",
      apiUrl: "http://localhost:8000",
      identity: "/tmp/test-identity.pem",
      startedAt: "2026-03-17T00:00:00.000Z",
      childStatusPath: "",
    });
    await Deno.writeTextFile(
      childStatusPathForStatePath(statePath),
      JSON.stringify({
        state: "mounted",
        pid: 321,
        mountpoint: "/tmp/test-mount",
        updatedAt: "2026-03-17T00:00:00.000Z",
      }),
    );
    await Deno.writeTextFile(
      `${statePath}.child-status.json`,
      JSON.stringify({
        state: "mounted",
        pid: 321,
        mountpoint: "/tmp/test-mount",
        updatedAt: "2026-03-17T00:00:00.000Z",
      }),
    );

    const states = await readAllMountStates(tmpDir);

    expect(states.map(({ path }) => path)).toEqual([statePath]);
  });

  it("formats active supervisor and child status rows", async () => {
    const statePath = await writeMountState(tmpDir, {
      pid: 123,
      childPid: 456,
      mountpoint: "/tmp/test-mount",
      apiUrl: "",
      identity: "",
      startedAt: "2026-03-17T00:00:00.000Z",
      logFile: "/tmp/cf-fuse-test-mount.log",
      childStatusPath: join(tmpDir, "child-status"),
    });
    await Deno.writeTextFile(
      join(tmpDir, "child-status"),
      JSON.stringify({
        state: "mounted",
        pid: 456,
        mountpoint: "/tmp/test-mount",
        updatedAt: "2026-03-17T00:00:01.000Z",
      }),
    );

    const rows = await buildMountStatusRows(await readAllMountStates(tmpDir), {
      isMountStateAlive: () => true,
    });

    expect(formatMountStatusTable(rows)).toBe([
      mountStatusHeader,
      [
        "/tmp/test-mount",
        "123",
        "456",
        "mounted",
        "2026-03-17T00:00:00.000Z",
        "/tmp/cf-fuse-test-mount.log",
      ].join("\t"),
    ].join("\n"));
    expect(rows).toHaveLength(1);
    expect((await Deno.stat(statePath)).isFile).toBe(true);
  });

  it("formats empty status after removing stale mount entries", async () => {
    const statePath = await writeMountState(tmpDir, {
      pid: 123,
      mountpoint: "/tmp/test-mount",
      apiUrl: "",
      identity: "",
      startedAt: "2026-03-17T00:00:00.000Z",
    });
    const removed: string[] = [];

    const rows = await buildMountStatusRows(await readAllMountStates(tmpDir), {
      isMountStateAlive: () => false,
      removeMountStateFile: async (path) => {
        removed.push(path);
        await Deno.remove(path);
      },
    });

    expect(rows).toEqual([]);
    expect(formatMountStatusTable(rows)).toBe("No active FUSE mounts.");
    expect(removed).toEqual([statePath]);
    await expect(Deno.stat(statePath)).rejects.toThrow();
  });

  it("rejects background mounts when child reports startup failure", async () => {
    const statePath = await writeMountState(tmpDir, {
      pid: Deno.pid,
      childPid: 321,
      mountpoint: "/tmp/test-mount",
      apiUrl: "http://localhost:8000",
      identity: "/tmp/test-identity.pem",
      startedAt: "2026-03-17T00:00:00.000Z",
    });
    const childStatusPath = childStatusPathForStatePath(statePath);
    const removed: string[] = [];

    await expect(
      awaitBackgroundMountStartup(fakeSupervisor().process, statePath, {
        childStatusPath,
        childStatusToken: "token-1",
        mountpoint: "/tmp/test-mount",
        isAlive: () => true,
        readTextFile: () =>
          Promise.resolve(JSON.stringify({
            state: "failed",
            pid: 321,
            mountpoint: "/tmp/test-mount",
            token: "token-1",
            updatedAt: "2026-03-17T00:00:00.000Z",
            error: "fuse_session_mount failed",
          })),
        watchStatus: () => fakeStatusWatcher(),
        removeStateFile: async (path: string) => {
          removed.push(path);
          await Deno.remove(path);
        },
      }),
    ).rejects.toThrow(/fuse_session_mount failed/);

    expect(removed).toEqual([statePath]);
    await expect(Deno.stat(statePath)).rejects.toThrow();
  });

  it("rejects background mounts when child exits during startup", async () => {
    const statePath = await writeMountState(tmpDir, {
      pid: Deno.pid,
      childPid: 321,
      mountpoint: "/tmp/test-mount",
      apiUrl: "http://localhost:8000",
      identity: "/tmp/test-identity.pem",
      startedAt: "2026-03-17T00:00:00.000Z",
    });
    const childStatusPath = childStatusPathForStatePath(statePath);
    const removed: string[] = [];

    await expect(
      awaitBackgroundMountStartup(fakeSupervisor().process, statePath, {
        childStatusPath,
        childStatusToken: "token-1",
        mountpoint: "/tmp/test-mount",
        isAlive: () => true,
        readTextFile: () =>
          Promise.resolve(JSON.stringify({
            state: "exiting",
            pid: 321,
            mountpoint: "/tmp/test-mount",
            token: "token-1",
            updatedAt: "2026-03-17T00:00:00.000Z",
          })),
        watchStatus: () => fakeStatusWatcher(),
        removeStateFile: async (path: string) => {
          removed.push(path);
          await Deno.remove(path);
        },
      }),
    ).rejects.toThrow(/child reported exiting/);

    expect(removed).toEqual([statePath]);
    await expect(Deno.stat(statePath)).rejects.toThrow();
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

  it("passes CFC mount options through to the daemon", () => {
    const args = buildDenoArgs({
      modPath: "/mod.ts",
      mountpoint: "/mnt",
      apiUrl: "",
      identity: "",
      execCli: "",
      allowOther: true,
      cfcMode: "enforce-explicit",
      cfcAnnotations: true,
      cfcXattrNamespace: "both",
      cfcWritebackXattrs: true,
      cfcWritebackState: "/tmp/cf-writeback.json",
    });
    expect(args).toContain("--allow-other");
    expect(args).toContain("--cfc-mode");
    expect(args).toContain("enforce-explicit");
    expect(args).toContain("--cfc-annotations");
    expect(args).toContain("--cfc-xattr-namespace");
    expect(args).toContain("both");
    expect(args).toContain("--cfc-writeback-xattrs");
    expect(args).toContain("--cfc-writeback-state");
    expect(args).toContain("/tmp/cf-writeback.json");
  });

  it("passes noattrcache through to the daemon", () => {
    const args = buildDenoArgs({
      modPath: "/mod.ts",
      mountpoint: "/mnt",
      apiUrl: "",
      identity: "",
      execCli: "",
      noattrcache: true,
    });
    expect(args).toContain("--noattrcache");
    expect(args).not.toContain("--attrcache-timeout");
  });

  it("passes attrcache-timeout through to the daemon", () => {
    const args = buildDenoArgs({
      modPath: "/mod.ts",
      mountpoint: "/mnt",
      apiUrl: "",
      identity: "",
      execCli: "",
      attrcacheTimeout: "2",
    });
    const flagIndex = args.indexOf("--attrcache-timeout");
    expect(flagIndex).toBeGreaterThan(-1);
    expect(args[flagIndex + 1]).toBe("2");
    expect(args).not.toContain("--noattrcache");
  });

  it("forwards an attrcache-timeout of zero to the daemon", () => {
    // "0" selects untuned caching in the daemon and must survive every
    // forwarding layer even though the layers test the field for truthiness.
    const args = buildDenoArgs({
      modPath: "/mod.ts",
      mountpoint: "/mnt",
      apiUrl: "",
      identity: "",
      execCli: "",
      attrcacheTimeout: "0",
    });
    const flagIndex = args.indexOf("--attrcache-timeout");
    expect(flagIndex).toBeGreaterThan(-1);
    expect(args[flagIndex + 1]).toBe("0");

    const supervisorArgs = buildBackgroundSupervisorDenoArgs({
      cliModPath: "/repo/packages/cli/lib/fuse-supervisor.ts",
      mountpoint: "/mnt",
      apiUrl: "",
      identity: "",
      execCli: "",
      attrcacheTimeout: "0",
    });
    const supIndex = supervisorArgs.indexOf("--attrcache-timeout");
    expect(supIndex).toBeGreaterThan(-1);
    expect(supervisorArgs[supIndex + 1]).toBe("0");

    const child = buildFuseChildCommand({
      mountpoint: "/mnt",
      apiUrl: "",
      identity: "",
      execCli: "",
      logFile: "",
      spaces: [],
      execPath: "/usr/local/bin/cf",
      attrcacheTimeout: "0",
    });
    const childIndex = child.args.indexOf("--attrcache-timeout");
    expect(childIndex).toBeGreaterThan(-1);
    expect(child.args[childIndex + 1]).toBe("0");
  });

  it("omits NFS cache mount options when unset", () => {
    const args = buildDenoArgs({
      modPath: "/mod.ts",
      mountpoint: "/mnt",
      apiUrl: "",
      identity: "",
      execCli: "",
    });
    expect(args).not.toContain("--noattrcache");
    expect(args).not.toContain("--attrcache-timeout");
  });
});

describe("FUSE supervisor command construction", () => {
  it("writes failed supervisor status for daemon startup failures", async () => {
    const writes: Array<{ state: string; extra?: Record<string, unknown> }> =
      [];

    await writeFailedSupervisorStartupStatus(
      new Error("connectSpace failed"),
      (state, extra) => {
        writes.push({ state, extra });
        return Promise.resolve();
      },
    );

    expect(writes).toEqual([{
      state: "failed",
      extra: { error: "Error: connectSpace failed" },
    }]);
  });

  it("builds a background supervisor invocation that does not load libfuse", () => {
    const args = buildBackgroundSupervisorDenoArgs({
      cliModPath: "/repo/packages/cli/lib/fuse-supervisor.ts",
      mountpoint: "/mnt",
      apiUrl: "http://localhost:8000",
      identity: "/tmp/id.key",
      execCli: "/tmp/cf-exec",
      logFile: "/tmp/cf-fuse-mnt.log",
      spaces: ["home", "work"],
      statePath: "/tmp/cf-state.json",
      supervisorStatusPath: "/tmp/cf-state.json.child-status",
      supervisorToken: "token-1",
      allowOther: true,
      noattrcache: true,
      cfcMode: "observe",
      cfcAnnotations: true,
      cfcXattrNamespace: "both",
      cfcWritebackXattrs: true,
      cfcWritebackState: "/tmp/cfc.json",
    });

    expect(args.slice(0, 2)).toEqual(["run", "--allow-run"]);
    expect(args).not.toContain("--allow-read");
    expect(args).not.toContain("--allow-write");
    expect(args).toContain("--allow-read=/tmp/cf-state.json");
    expect(args).toContain("--allow-write=/tmp/cf-state.json");
    expect(args).not.toContain("--allow-env");
    expect(args).not.toContain("--allow-net");
    expect(args).not.toContain("--unstable-ffi");
    expect(args).not.toContain("--allow-ffi");
    expect(args).toContain("/repo/packages/cli/lib/fuse-supervisor.ts");
    expect(args).not.toContain("fuse-supervisor");
    expect(args).not.toContain("/repo/packages/fuse/mod.ts");
    expect(args).not.toContain("fuse-daemon");
    expect(args).toContain("--log-file");
    expect(args).toContain("/tmp/cf-fuse-mnt.log");
    expect(args).toContain("--state-path");
    expect(args).toContain("/tmp/cf-state.json");
    expect(args).toContain("--supervisor-status");
    expect(args).toContain("/tmp/cf-state.json.child-status");
    expect(args).toContain("--supervisor-token");
    expect(args).toContain("token-1");
    expect(args).toContain("--noattrcache");
    expect(args.filter((arg) => arg === "--space").length).toBe(2);
  });

  it("builds a distinct FUSE child invocation that owns libfuse", () => {
    const supervisorArgs = buildBackgroundSupervisorDenoArgs({
      cliModPath: "/repo/packages/cli/lib/fuse-supervisor.ts",
      mountpoint: "/mnt",
      apiUrl: "",
      identity: "",
      execCli: "",
      logFile: "/tmp/cf-fuse-mnt.log",
      spaces: [],
      supervisorStatusPath: "/tmp/cf-status.json",
      supervisorToken: "token-1",
    });
    const childArgs = buildFuseChildDenoArgs({
      modPath: "/repo/packages/fuse/mod.ts",
      mountpoint: "/mnt",
      apiUrl: "",
      identity: "",
      execCli: "",
      logFile: "/tmp/cf-fuse-mnt.log",
      spaces: [],
      supervisorStatusPath: "/tmp/cf-status.json",
      supervisorToken: "token-1",
    });

    expect(childArgs).not.toEqual(supervisorArgs);
    expect(childArgs).toContain("--unstable-ffi");
    expect(childArgs).toContain("--allow-ffi");
    expect(childArgs).toContain("/repo/packages/fuse/mod.ts");
    expect(childArgs).toContain("--supervisor-status");
    expect(childArgs).toContain("/tmp/cf-status.json");
    expect(childArgs).toContain("--supervisor-token");
    expect(childArgs).toContain("token-1");
    expect(childArgs).not.toContain(
      "/repo/packages/cli/lib/fuse-supervisor.ts",
    );
    expect(childArgs).not.toContain("fuse-supervisor");
  });

  it("represents the supervisor-spawned FUSE child as a distinct command", () => {
    const child = buildFuseChildCommand({
      mountpoint: "/mnt",
      apiUrl: "http://localhost:8000",
      identity: "/tmp/id.key",
      execCli: "/tmp/cf-exec",
      logFile: "/tmp/cf-fuse-mnt.log",
      spaces: ["home"],
      importMetaUrl: toFileUrl("/repo/packages/cli/lib/fuse-supervisor.ts")
        .href,
      execPath: "/usr/bin/deno",
    });

    expect(child.command).toBe("/usr/bin/deno");
    expect(child.args).toContain("--allow-ffi");
    expect(child.args).toContain("/repo/packages/fuse/mod.ts");
    expect(child.args).not.toContain("fuse-supervisor");
    expect(child.args).not.toContain("/repo/packages/cli/mod.ts");
  });

  it("represents the compiled supervisor-spawned FUSE child as a hidden subcommand", () => {
    const child = buildFuseChildCommand({
      mountpoint: "/mnt",
      apiUrl: "http://localhost:8000",
      identity: "/tmp/id.key",
      execCli: "/tmp/cf-exec",
      logFile: "/tmp/cf-fuse-mnt.log",
      spaces: ["home"],
      execPath: "/usr/local/bin/cf",
      supervisorStatusPath: "/tmp/cf-status",
      supervisorToken: "token-1",
      attrcacheTimeout: "2",
    });

    expect(child.command).toBe("/usr/local/bin/cf");
    expect(child.args).toContain("fuse-daemon");
    expect(child.args).toContain("--supervisor-status");
    expect(child.args).toContain("/tmp/cf-status");
    expect(child.args).toContain("--supervisor-token");
    expect(child.args).toContain("token-1");
    const flagIndex = child.args.indexOf("--attrcache-timeout");
    expect(flagIndex).toBeGreaterThan(-1);
    expect(child.args[flagIndex + 1]).toBe("2");
  });

  it("terminates the spawned FUSE child during supervisor cleanup", async () => {
    const signals: Deno.Signal[] = [];

    await cleanupFuseChild({
      killed: false,
      kill: (signal: Deno.Signal) => {
        signals.push(signal);
      },
    });

    expect(signals).toEqual(["SIGTERM"]);
  });

  it("does not terminate the spawned FUSE child after it has already exited", async () => {
    const signals: Deno.Signal[] = [];

    await cleanupFuseChild({
      killed: true,
      kill: (signal: Deno.Signal) => {
        signals.push(signal);
      },
    });

    expect(signals).toEqual([]);
  });

  it("waits for the spawned FUSE child during supervisor cleanup", async () => {
    const signals: Deno.Signal[] = [];
    let resolveStatus: (status: Deno.CommandStatus) => void = () => undefined;
    const status = new Promise<Deno.CommandStatus>((resolve) => {
      resolveStatus = resolve;
    });

    await cleanupFuseChild({
      killed: false,
      status,
      kill: (signal: Deno.Signal) => {
        signals.push(signal);
        resolveStatus({ success: true, code: 0, signal: null });
      },
    });

    expect(signals).toEqual(["SIGTERM"]);
  });

  it("escalates if the spawned FUSE child ignores graceful cleanup", async () => {
    const signals: Deno.Signal[] = [];
    let resolveStatus: (status: Deno.CommandStatus) => void = () => undefined;
    const status = new Promise<Deno.CommandStatus>((resolve) => {
      resolveStatus = resolve;
    });

    await cleanupFuseChild({
      killed: false,
      status,
      kill: (signal: Deno.Signal) => {
        signals.push(signal);
        if (signal === "SIGKILL") {
          resolveStatus({ success: false, code: 137, signal: "SIGKILL" });
        }
      },
    }, {
      timeoutMs: 0,
    });

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("recognizes Deno and compiled FUSE supervisor process commands", () => {
    expect(
      isFuseProcessCommand("deno run packages/cli/lib/fuse-supervisor.ts /mnt"),
    )
      .toBe(true);
    expect(isFuseProcessCommand("/usr/local/bin/cf fuse-supervisor /mnt"))
      .toBe(true);
    expect(isFuseProcessCommand("/usr/local/bin/cf fuse-daemon /mnt"))
      .toBe(true);
    expect(isFuseProcessCommand("deno run packages/fuse/mod.ts /mnt"))
      .toBe(true);
    expect(isFuseProcessCommand("deno run unrelated.ts fuse"))
      .toBe(false);
  });

  it("treats a live FUSE child PID as active mount state", () => {
    expect(isMountStateAlive({
      pid: 1073741824,
      childPid: Deno.pid,
      mountpoint: "/tmp/test-mount",
      apiUrl: "",
      identity: "",
      startedAt: "2026-03-17T00:00:00.000Z",
    })).toBe(true);
  });

  it("records childPid only into state owned by the supervisor PID", async () => {
    const statePath = await Deno.makeTempFile({ prefix: "cf-fuse-state-" });
    try {
      await Deno.writeTextFile(
        statePath,
        JSON.stringify({
          pid: 100,
          mountpoint: "/tmp/test-mount",
          apiUrl: "",
          identity: "",
          startedAt: "2026-03-17T00:00:00.000Z",
        }),
      );

      const staleResult = await recordFuseChildPid({
        statePath,
        childPid: 300,
        supervisorPid: 200,
        sleep: () => Promise.resolve(),
      });
      const staleState = JSON.parse(await Deno.readTextFile(statePath)) as {
        childPid?: number;
      };

      expect(staleResult).toBe(false);
      expect(staleState.childPid).toBeUndefined();

      await Deno.writeTextFile(
        statePath,
        JSON.stringify({
          pid: 200,
          mountpoint: "/tmp/test-mount",
          apiUrl: "",
          identity: "",
          startedAt: "2026-03-17T00:00:00.000Z",
        }),
      );

      const matchingResult = await recordFuseChildPid({
        statePath,
        childPid: 300,
        supervisorPid: 200,
        sleep: () => Promise.resolve(),
      });
      const matchingState = JSON.parse(await Deno.readTextFile(statePath)) as {
        childPid?: number;
      };

      expect(matchingResult).toBe(true);
      expect(matchingState.childPid).toBe(300);
    } finally {
      await Deno.remove(statePath).catch(() => undefined);
    }
  });

  it("fails supervisor startup when childPid cannot be recorded", async () => {
    const statePath = await Deno.makeTempFile({ prefix: "cf-fuse-state-" });
    const signals: Deno.Signal[] = [];
    let resolveStatus: (status: Deno.CommandStatus) => void = () => undefined;

    class FakeCommand {
      constructor(_command: string | URL, _options: Deno.CommandOptions) {}

      spawn() {
        return {
          pid: 300,
          status: new Promise<Deno.CommandStatus>((resolve) => {
            resolveStatus = resolve;
          }),
          kill: (signal: Deno.Signal) => {
            signals.push(signal);
            resolveStatus({ success: true, code: 143, signal });
          },
        };
      }
    }

    try {
      await Deno.writeTextFile(
        statePath,
        JSON.stringify({
          pid: 100,
          mountpoint: "/tmp/test-mount",
          apiUrl: "",
          identity: "",
          startedAt: "2026-03-17T00:00:00.000Z",
        }),
      );

      await expect(runFuseSupervisor({
        mountpoint: "/tmp/test-mount",
        apiUrl: "",
        identity: "",
        execCli: "",
        logFile: "",
        spaces: [],
        statePath,
        supervisorPid: 200,
        command: FakeCommand,
        sleep: () => Promise.resolve(),
        addSignalListener: () => undefined,
        removeSignalListener: () => undefined,
      })).rejects.toThrow(/Unable to record FUSE child PID/);

      expect(signals).toEqual(["SIGTERM"]);
    } finally {
      await Deno.remove(statePath).catch(() => undefined);
    }
  });

  it("installs supervisor signal handlers before recording childPid", async () => {
    const statePath = await Deno.makeTempFile({ prefix: "cf-fuse-state-" });
    const addedSignals: Deno.Signal[] = [];
    let handlersInstalledBeforeRecord = false;

    class FakeCommand {
      constructor(_command: string | URL, _options: Deno.CommandOptions) {}

      spawn() {
        return {
          pid: 300,
          status: Promise.resolve({ success: true, code: 0, signal: null }),
          kill: () => undefined,
        };
      }
    }

    try {
      await Deno.writeTextFile(
        statePath,
        JSON.stringify({
          pid: 100,
          mountpoint: "/tmp/test-mount",
          apiUrl: "",
          identity: "",
          startedAt: "2026-03-17T00:00:00.000Z",
        }),
      );

      await expect(runFuseSupervisor({
        mountpoint: "/tmp/test-mount",
        apiUrl: "",
        identity: "",
        execCli: "",
        logFile: "",
        spaces: [],
        statePath,
        supervisorPid: 200,
        command: FakeCommand,
        sleep: async () => {
          handlersInstalledBeforeRecord = addedSignals.includes("SIGTERM") &&
            addedSignals.includes("SIGINT");
          await Deno.writeTextFile(
            statePath,
            JSON.stringify({
              pid: 200,
              mountpoint: "/tmp/test-mount",
              apiUrl: "",
              identity: "",
              startedAt: "2026-03-17T00:00:00.000Z",
            }),
          );
        },
        addSignalListener: (signal) => {
          addedSignals.push(signal);
        },
        removeSignalListener: () => undefined,
        exit: (code: number) => {
          throw new Error(`exit:${code}`);
        },
      })).rejects.toThrow(/exit:0/);

      expect(handlersInstalledBeforeRecord).toBe(true);
    } finally {
      await Deno.remove(statePath).catch(() => undefined);
    }
  });
});

describe("buildFuseBinaryArgs", () => {
  const base = {
    mountpoint: "/mnt",
    apiUrl: "http://localhost:8000",
    identity: "/tmp/id.key",
    execCli: "/tmp/cf-exec",
  };

  it("builds a compiled-binary daemon invocation", () => {
    const args = buildFuseBinaryArgs({
      subcommand: "fuse-daemon",
      ...base,
      spaces: ["home", "work"],
    });

    expect(args.slice(0, 2)).toEqual(["fuse-daemon", "/mnt"]);
    expect(args).not.toContain("run");
    expect(args).not.toContain("--allow-ffi");
    expect(args).not.toContain("fuse-supervisor");
    const apiIndex = args.indexOf("--api-url");
    expect(args[apiIndex + 1]).toBe("http://localhost:8000");
    const identityIndex = args.indexOf("--identity");
    expect(args[identityIndex + 1]).toBe("/tmp/id.key");
    const execIndex = args.indexOf("--exec-cli");
    expect(args[execIndex + 1]).toBe("/tmp/cf-exec");
    expect(args.filter((arg) => arg === "--space").length).toBe(2);
  });

  it("builds a compiled-binary supervisor invocation with its lifecycle paths", () => {
    const args = buildFuseBinaryArgs({
      subcommand: "fuse-supervisor",
      ...base,
      logFile: "/tmp/cf-fuse.log",
      statePath: "/tmp/state.json",
      supervisorStatusPath: "/tmp/state.json.child-status",
      supervisorToken: "token-1",
    });

    expect(args.slice(0, 2)).toEqual(["fuse-supervisor", "/mnt"]);
    const logIndex = args.indexOf("--log-file");
    expect(args[logIndex + 1]).toBe("/tmp/cf-fuse.log");
    const stateIndex = args.indexOf("--state-path");
    expect(args[stateIndex + 1]).toBe("/tmp/state.json");
    const statusIndex = args.indexOf("--supervisor-status");
    expect(args[statusIndex + 1]).toBe("/tmp/state.json.child-status");
    const tokenIndex = args.indexOf("--supervisor-token");
    expect(args[tokenIndex + 1]).toBe("token-1");
  });

  it("omits every optional flag that was not requested", () => {
    const args = buildFuseBinaryArgs({
      subcommand: "fuse-daemon",
      mountpoint: "/mnt",
      apiUrl: "",
      identity: "",
      execCli: "",
    });

    expect(args).toEqual(["fuse-daemon", "/mnt"]);
  });

  it("forwards the mount and CFC flags", () => {
    const args = buildFuseBinaryArgs({
      subcommand: "fuse-daemon",
      ...base,
      allowOther: true,
      noattrcache: true,
      cfcMode: "enforce-explicit",
      cfcAnnotations: true,
      cfcXattrNamespace: "both",
      cfcWritebackXattrs: true,
      cfcWritebackState: "/tmp/cfc.json",
    });

    expect(args).toContain("--allow-other");
    expect(args).toContain("--noattrcache");
    const modeIndex = args.indexOf("--cfc-mode");
    expect(args[modeIndex + 1]).toBe("enforce-explicit");
    expect(args).toContain("--cfc-annotations");
    const nsIndex = args.indexOf("--cfc-xattr-namespace");
    expect(args[nsIndex + 1]).toBe("both");
    expect(args).toContain("--cfc-writeback-xattrs");
    const stateIndex = args.indexOf("--cfc-writeback-state");
    expect(args[stateIndex + 1]).toBe("/tmp/cfc.json");
  });

  it("forwards an attrcache-timeout of zero", () => {
    const args = buildFuseBinaryArgs({
      subcommand: "fuse-daemon",
      ...base,
      attrcacheTimeout: "0",
    });

    const flagIndex = args.indexOf("--attrcache-timeout");
    expect(flagIndex).toBeGreaterThan(-1);
    expect(args[flagIndex + 1]).toBe("0");
    expect(args).not.toContain("--noattrcache");
  });
});

describe("parseSupervisorArgs", () => {
  it("parses the mountpoint and cache flags", () => {
    const { options, help } = parseSupervisorArgs([
      "/mnt",
      "--api-url",
      "http://localhost:8000",
      "--noattrcache",
      "--space",
      "home",
    ]);

    expect(help).toBe(false);
    expect(options.mountpoint).toBe("/mnt");
    expect(options.apiUrl).toBe("http://localhost:8000");
    expect(options.noattrcache).toBe(true);
    expect(options.attrcacheTimeout).toBeUndefined();
    expect(options.spaces).toEqual(["home"]);
  });

  it("parses an attrcache-timeout value, including zero", () => {
    expect(
      parseSupervisorArgs(["/mnt", "--attrcache-timeout", "2"]).options
        .attrcacheTimeout,
    ).toBe("2");
    expect(
      parseSupervisorArgs(["/mnt", "--attrcache-timeout", "0"]).options
        .attrcacheTimeout,
    ).toBe("0");
  });

  it("rejects an attrcache-timeout with no value", () => {
    expect(() => parseSupervisorArgs(["/mnt", "--attrcache-timeout"]))
      .toThrow("Missing value for --attrcache-timeout");
  });

  it("rejects unknown options", () => {
    expect(() => parseSupervisorArgs(["/mnt", "--nosuchflag"]))
      .toThrow("Unknown fuse supervisor option: --nosuchflag");
  });

  it("reports help without requiring a mountpoint", () => {
    expect(parseSupervisorArgs(["--help"]).help).toBe(true);
    expect(supervisorHelp()).toContain("--attrcache-timeout <seconds>");
    expect(supervisorHelp()).toContain("--noattrcache");
  });
});

describe("fuse mount option validation", () => {
  // The mount action validates before it resolves an identity, creates the
  // mountpoint, or spawns anything, so these never reach a real mount.
  const neverMounted = "/tmp/cf-fuse-never-mounted";

  it("rejects an attrcache-timeout below the supported range", async () => {
    await expect(
      fuse.parse(["mount", neverMounted, "--attrcache-timeout", "-1"]),
    ).rejects.toThrow("Invalid --attrcache-timeout value: -1");
    await expect(Deno.stat(neverMounted)).rejects.toThrow(Deno.errors.NotFound);
  });

  it("rejects an attrcache-timeout above the supported range", async () => {
    await expect(
      fuse.parse(["mount", neverMounted, "--attrcache-timeout", "86401"]),
    ).rejects.toThrow("Invalid --attrcache-timeout value: 86401");
  });

  it("documents both cache flags in the mount help", () => {
    const help = fuse.getCommand("mount")!.getHelp();
    expect(help).toContain("--noattrcache");
    expect(help).toContain("--attrcache-timeout");
    expect(help).toContain("Conflicts");
  });
});
