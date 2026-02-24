import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import {
  buildDenoArgs,
  isAlive,
  mountpointHash,
  readAllPidFiles,
  readPidFile,
  writePidFile,
} from "../lib/fuse.ts";

describe("mountpointHash", () => {
  it("returns a 16-char hex string", async () => {
    const hash = await mountpointHash("/tmp/ct-fuse");
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is deterministic", async () => {
    const a = await mountpointHash("/tmp/ct-fuse");
    const b = await mountpointHash("/tmp/ct-fuse");
    expect(a).toBe(b);
  });

  it("differs for different paths", async () => {
    const a = await mountpointHash("/tmp/ct-fuse-a");
    const b = await mountpointHash("/tmp/ct-fuse-b");
    expect(a).not.toBe(b);
  });
});

describe("PID file operations", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await Deno.makeTempDir({ prefix: "ct-fuse-test-" });
  });

  afterEach(async () => {
    await Deno.remove(tmpDir, { recursive: true });
  });

  it("writePidFile creates file and readPidFile reads it back", async () => {
    const entry = {
      pid: 12345,
      mountpoint: "/tmp/test-mount",
      apiUrl: "http://localhost:8000",
      startedAt: "2026-02-24T00:00:00.000Z",
    };

    const path = await writePidFile(tmpDir, entry);
    expect(path).toContain(tmpDir);
    expect(path).toMatch(/\.json$/);

    const result = await readPidFile(tmpDir, "/tmp/test-mount");
    expect(result).not.toBeNull();
    expect(result!.entry).toEqual(entry);
    expect(result!.path).toBe(path);
  });

  it("readPidFile returns null for missing mountpoint", async () => {
    const result = await readPidFile(tmpDir, "/nonexistent/path");
    expect(result).toBeNull();
  });

  it("readPidFile returns null when state dir does not exist", async () => {
    const result = await readPidFile(
      join(tmpDir, "nonexistent"),
      "/tmp/test",
    );
    expect(result).toBeNull();
  });

  it("readAllPidFiles returns all entries", async () => {
    await writePidFile(tmpDir, {
      pid: 111,
      mountpoint: "/tmp/mount-a",
      apiUrl: "http://localhost:8000",
      startedAt: "2026-02-24T00:00:00.000Z",
    });
    await writePidFile(tmpDir, {
      pid: 222,
      mountpoint: "/tmp/mount-b",
      apiUrl: "http://localhost:9000",
      startedAt: "2026-02-24T01:00:00.000Z",
    });

    const all = await readAllPidFiles(tmpDir);
    expect(all.length).toBe(2);

    const pids = all.map((r) => r.entry.pid).sort();
    expect(pids).toEqual([111, 222]);
  });

  it("readAllPidFiles returns empty for nonexistent dir", async () => {
    const all = await readAllPidFiles(join(tmpDir, "nope"));
    expect(all).toEqual([]);
  });

  it("readAllPidFiles skips corrupt JSON files", async () => {
    // Write a valid entry
    await writePidFile(tmpDir, {
      pid: 333,
      mountpoint: "/tmp/mount-ok",
      apiUrl: "",
      startedAt: "2026-02-24T00:00:00.000Z",
    });

    // Write a corrupt file
    await Deno.writeTextFile(join(tmpDir, "corrupt.json"), "not json{{{");

    const all = await readAllPidFiles(tmpDir);
    expect(all.length).toBe(1);
    expect(all[0].entry.pid).toBe(333);
  });

  it("readAllPidFiles ignores non-json files", async () => {
    await writePidFile(tmpDir, {
      pid: 444,
      mountpoint: "/tmp/mount-x",
      apiUrl: "",
      startedAt: "2026-02-24T00:00:00.000Z",
    });
    await Deno.writeTextFile(join(tmpDir, "readme.txt"), "ignore me");

    const all = await readAllPidFiles(tmpDir);
    expect(all.length).toBe(1);
  });

  it("writePidFile overwrites existing entry for same mountpoint", async () => {
    const mp = "/tmp/same-mount";
    await writePidFile(tmpDir, {
      pid: 100,
      mountpoint: mp,
      apiUrl: "",
      startedAt: "2026-02-24T00:00:00.000Z",
    });
    await writePidFile(tmpDir, {
      pid: 200,
      mountpoint: mp,
      apiUrl: "http://new",
      startedAt: "2026-02-24T01:00:00.000Z",
    });

    const result = await readPidFile(tmpDir, mp);
    expect(result!.entry.pid).toBe(200);
    expect(result!.entry.apiUrl).toBe("http://new");

    // Only one file should exist for this mountpoint
    const all = await readAllPidFiles(tmpDir);
    expect(all.length).toBe(1);
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
      spaces: [],
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
      spaces: [],
    });
    expect(args).toContain("--api-url");
    expect(args).toContain("http://localhost:8000");
    expect(args).toContain("--identity");
    expect(args).toContain("./key.pem");
  });

  it("includes multiple spaces", () => {
    const args = buildDenoArgs({
      modPath: "/mod.ts",
      mountpoint: "/mnt",
      apiUrl: "",
      identity: "",
      spaces: ["home", "work"],
    });
    const spaceIndices = args.reduce<number[]>((acc, v, i) => {
      if (v === "--space") acc.push(i);
      return acc;
    }, []);
    expect(spaceIndices.length).toBe(2);
    expect(args[spaceIndices[0] + 1]).toBe("home");
    expect(args[spaceIndices[1] + 1]).toBe("work");
  });
});
