import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  byDayThenName,
  dayPartitions,
  inputChoice,
  parseArgs,
  partitionOf,
  publish,
  type StoreAccess,
  writeToken,
} from "./test-selection-publish.ts";
import {
  buildObjectBody,
  gunzipToText,
  parseManifest,
  type RunContext,
  type TestRecord,
} from "@commonfabric/test-support/records";
import { reportFromText } from "./test-selection/build.ts";
import type { Suite } from "./test-topology/suite.ts";
import { join } from "@std/path";

/**
 * A topology holding the one suite these cases record against. Supplied
 * rather than read from the tree: what the publisher does with a
 * classified identity is the subject, and walking the repository for
 * every case would make each of them depend on what the tree holds.
 */
const TOPOLOGY: Suite[] = [{
  id: "workspace-unit",
  recordSurfaces: [{ kind: "unit", scope: "memory" }],
  needs: ["deno"],
  units: ["packages/memory/test/space.test.ts"],
  unavailable: [],
  locate: (record) =>
    record.test.k === "unit" && record.test.s === "memory"
      ? { level: "unit", unit: "packages/memory/test/space.test.ts" }
      : undefined,
  command: () => Promise.resolve([]),
}];

const suites = () => Promise.resolve(TOPOLOGY);

const CI = (day: string, run: string) =>
  `labs/test-records/submissions/ci/v1/${day}/run-${run}-a.ndjson`;
const LOCAL = (day: string, who: string) =>
  `labs/test-records/submissions/local/${who}/v1/${day}/01K3-branch.ndjson`;

describe("test-selection-publish", () => {
  describe("parseArgs()", () => {
    it("defaults to the incremental path", () => {
      const options = parseArgs([]);
      expect(options?.bootstrap).toBe(false);
      expect(options?.dryRun).toBe(false);
    });

    it("widens the window for a bootstrap", () => {
      expect(parseArgs(["--bootstrap"])?.days).toBe(60);
    });

    it("lets an asked-for window win, whichever order it was typed", () => {
      expect(parseArgs(["--days", "3", "--bootstrap"])?.days).toBe(3);
      expect(parseArgs(["--bootstrap", "--days", "3"])?.days).toBe(3);
    });

    it("takes a window, an output directory, and a concurrency", () => {
      const options = parseArgs([
        "--days",
        "3",
        "--out",
        "/tmp/out",
        "--concurrency",
        "8",
      ]);
      expect(options?.days).toBe(3);
      expect(options?.out).toBe("/tmp/out");
      expect(options?.concurrency).toBe(8);
    });

    it("returns undefined for anything it does not understand", () => {
      expect(parseArgs(["--nonsense"])).toBeUndefined();
      expect(parseArgs(["--days", "0"])).toBeUndefined();
      expect(parseArgs(["--days"])).toBeUndefined();
      expect(parseArgs(["--concurrency", "x"])).toBeUndefined();
      expect(parseArgs(["--out"])).toBeUndefined();
    });
  });

  describe("dayPartitions()", () => {
    it("lists the window oldest first", () => {
      expect(dayPartitions(new Date("2026-08-20T04:00:00Z"), 3)).toEqual([
        "2026/08/18",
        "2026/08/19",
        "2026/08/20",
      ]);
    });

    it("lists one day for a window of one", () => {
      expect(dayPartitions(new Date("2026-08-20T04:00:00Z"), 1)).toEqual([
        "2026/08/20",
      ]);
    });
  });

  describe("partitionOf()", () => {
    it("reads the day out of either area's names", () => {
      expect(partitionOf(CI("2026/08/20", "1"))).toBe("2026/08/20");
      expect(partitionOf(LOCAL("2026/08/20", "ianh"))).toBe("2026/08/20");
    });

    it("reads nothing out of a name that carries no day", () => {
      expect(partitionOf("labs/test-selection/v1/state/x.json.gz")).toBe("");
    });
  });

  describe("inputChoice()", () => {
    it("passes over a pair whose receipt says its rollup is folded", () => {
      // Rollups of this format carry no record of which arrivals they
      // cover, so nothing can say how much a raw object would repeat.
      expect(
        inputChoice({ settled: true, foldedRaw: false, rollup: true }),
      ).toBe("settled");
      expect(
        inputChoice({ settled: true, foldedRaw: true, rollup: true }),
      ).toBe("settled");
    });

    it("takes the rollup of a pair nothing has been folded from", () => {
      expect(
        inputChoice({ settled: false, foldedRaw: false, rollup: true }),
      ).toBe("rollup");
    });

    it("keeps a pair with raw contributions on the raw path", () => {
      // A rollup written afterwards would overlap them.
      expect(
        inputChoice({ settled: false, foldedRaw: true, rollup: true }),
      ).toBe("raw");
    });

    it("reads raw where there is no rollup, which is every local source", () => {
      expect(
        inputChoice({ settled: false, foldedRaw: false, rollup: false }),
      ).toBe("raw");
    });
  });

  describe("byDayThenName()", () => {
    it("interleaves the two areas by the day they recorded", () => {
      // Sorted by name alone, every local object lands after every
      // continuous-integration one, and the fold would judge a
      // workstation's failure against a state from days later.
      const ordered = [
        LOCAL("2026/08/20", "ianh"),
        CI("2026/08/18", "1"),
        LOCAL("2026/08/19", "ianh"),
        CI("2026/08/20", "2"),
      ].sort(byDayThenName);
      expect(ordered.map(partitionOf)).toEqual([
        "2026/08/18",
        "2026/08/19",
        "2026/08/20",
        "2026/08/20",
      ]);
    });

    it("falls back to the name inside one day", () => {
      const ordered = [CI("2026/08/20", "2"), CI("2026/08/20", "1")]
        .sort(byDayThenName);
      expect(ordered[0]).toBe(CI("2026/08/20", "1"));
    });
  });
});

/** A store held in memory, answering the way the real one answers. */
function fakeStore(
  objects: Record<string, string>,
  rollups: Record<string, string[]> = {},
) {
  const created = new Map<string, Uint8Array>();
  const store: StoreAccess = {
    list: (prefix) =>
      Promise.resolve(
        [...Object.keys(objects), ...created.keys()]
          .filter((name) => name.startsWith(prefix))
          .sort(),
      ),
    read: (objectName) => {
      const text = objects[objectName];
      if (text === undefined) throw new Error(`no such object ${objectName}`);
      return Promise.resolve(reportFromText(objectName, text));
    },
    readText: (objectName) => {
      const stored = created.get(objectName);
      if (stored !== undefined) return gunzipToText(stored);
      const text = objects[objectName];
      if (text === undefined) throw new Error(`no such object ${objectName}`);
      return Promise.resolve(text);
    },
    create: (name, body) => {
      created.set(name, body);
      return Promise.resolve();
    },
    rollupShards: (day) => Promise.resolve(rollups[day]),
    token: () => "a token",
  };
  return { store, created };
}

const DAY = "2026/08/20";

/** One object holding one run of one test, at one commit. */
function object(
  commit: string,
  outcome: TestRecord["outcome"],
  at: string,
): string {
  const context: RunContext = {
    schema: 1,
    line: "context",
    reportId: `report-${commit}-${outcome}`,
    repo: "commontoolsinc/labs",
    commit,
    dirty: false,
    branch: "main",
    env: "ci",
    ci: {
      workflowRunId: commit,
      runAttempt: 1,
      workflow: "deno.yml",
      job: "Test (1/8)",
      event: "push",
    },
    os: "linux",
    arch: "x86_64",
    denoVersion: "2.9.4",
    startedAt: at,
  };
  const record: TestRecord = {
    line: "record",
    test: { k: "unit", s: "memory", n: "space > writes" },
    outcome,
    durationMs: 40,
  };
  return buildObjectBody(context, [record]);
}

/** One object holding one run of one test on somebody's workstation. */
function localObject(commit: string, at: string): string {
  const context: RunContext = {
    schema: 1,
    line: "context",
    reportId: `report-${commit}`,
    repo: "commontoolsinc/labs",
    commit,
    dirty: false,
    branch: "fix-writes",
    env: "local",
    os: "linux",
    arch: "x86_64",
    denoVersion: "2.9.4",
    startedAt: at,
  };
  return buildObjectBody(context, [{
    line: "record",
    test: { k: "unit", s: "memory", n: "space > writes" },
    outcome: "fail",
    durationMs: 40,
  }]);
}

/** The two runs a fresh store is seeded with: a failure, then its fix. */
function seed(): Record<string, string> {
  return {
    [CI(DAY, "1")]: object("c1", "fail", "2026-08-20T01:00:00.000Z"),
    [CI(DAY, "2")]: object("c2", "pass", "2026-08-20T02:00:00.000Z"),
  };
}

describe("publish()", () => {
  const NOW = new Date("2026-08-20T12:00:00.000Z");

  it("refuses a first run that was not asked for", async () => {
    // An absent aggregate is either a genuine first run or one that went
    // missing, and an incremental run cannot tell the two apart.
    const { store, created } = fakeStore(seed());
    expect(await publish(["--days", "1"], store, NOW, suites)).toBe(1);
    expect(created.size).toBe(0);
  });

  it("writes a manifest and a state from a bootstrap", async () => {
    const { store, created } = fakeStore(seed());
    expect(await publish(["--bootstrap", "--days", "1"], store, NOW, suites))
      .toBe(0);
    const names = [...created.keys()];
    const manifestName = names.find((name) => name.includes("/manifest-"));
    expect(manifestName).toBeDefined();
    expect(names.some((name) => name.includes("/state/"))).toBe(true);

    const manifest = parseManifest(
      await gunzipToText(created.get(manifestName!)!),
    );
    expect(manifest).toBeDefined();
    expect(manifest!.entries.length).toBe(1);
    // The suite and the unit are the topology's, which is what a lane
    // looks a suite up by and what the packer charges overheads to. A
    // surface derived from the record's own kind and scope would match
    // no suite the tree holds, and every selection naming it would be
    // dropped for naming a suite that does not exist.
    expect(manifest!.entries[0]!.suite).toBe("workspace-unit");
    expect(manifest!.entries[0]!.unit).toBe(
      "packages/memory/test/space.test.ts",
    );
    // The failure at c1 that c2 went on to fix is a catch on main.
    expect(manifest!.entries[0]!.inputs.mainCatches).toBe(1);
  });

  it("leaves out an identity no suite claims, and says how many", async () => {
    // Nothing can be asked to run it, so carrying it would put an entry
    // in the manifest that every pass would consider and no lane could
    // place. Saying how many there are is what keeps that visible.
    const lines: string[] = [];
    const log = console.log;
    console.log = (line: string) => lines.push(line);
    const { store, created } = fakeStore(seed());
    try {
      await publish(
        ["--bootstrap", "--days", "1"],
        store,
        NOW,
        () => Promise.resolve([]),
      );
    } finally {
      console.log = log;
    }
    const manifestName = [...created.keys()].find((name) =>
      name.includes("/manifest-")
    );
    const manifest = parseManifest(
      await gunzipToText(created.get(manifestName!)!),
    );
    expect(manifest!.entries).toEqual([]);
    expect(lines.join("\n")).toContain("1 identities no suite claims");
  });

  it("folds from the state it left rather than the objects again", async () => {
    const { store, created } = fakeStore(seed());
    await publish(["--bootstrap", "--days", "1"], store, NOW, suites);
    const first = created.size;
    const readObjects: string[] = [];
    const watched: StoreAccess = {
      ...store,
      read: (name) => {
        readObjects.push(name);
        return store.read(name);
      },
    };
    expect(await publish(["--days", "1"], watched, NOW, suites)).toBe(0);
    expect(readObjects).toEqual([]);
    expect(created.size).toBeGreaterThan(first);
  });

  it("refuses to publish when the state area cannot be listed", async () => {
    const { store, created } = fakeStore(seed());
    const broken: StoreAccess = {
      ...store,
      list: (prefix) =>
        prefix.includes("/state")
          ? Promise.reject(new Error("unreachable"))
          : store.list(prefix),
    };
    expect(await publish(["--days", "1"], broken, NOW, suites)).toBe(1);
    expect(created.size).toBe(0);
  });

  it("refuses to publish from a window it could only partly read", async () => {
    const { store, created } = fakeStore(seed());
    await publish(["--bootstrap", "--days", "1"], store, NOW, suites);
    const after = created.size;
    const broken: StoreAccess = {
      ...store,
      read: () => Promise.reject(new Error("that object is gone")),
      list: (prefix) =>
        prefix.includes("/state")
          ? store.list(prefix)
          : Promise.resolve([CI(DAY, "9")]),
    };
    expect(await publish(["--days", "1"], broken, NOW, suites)).toBe(1);
    expect(created.size).toBe(after);
  });

  it("creates nothing at all for a dry run", async () => {
    const { store, created } = fakeStore(seed());
    const code = await publish(
      ["--bootstrap", "--days", "1", "--dry-run"],
      store,
      NOW,
      suites,
    );
    expect(code).toBe(0);
    expect(created.size).toBe(0);
  });

  it("creates nothing without a credential", async () => {
    const { store, created } = fakeStore(seed());
    const anonymous: StoreAccess = { ...store, token: () => undefined };
    const code = await publish(
      ["--bootstrap", "--days", "1"],
      anonymous,
      NOW,
      suites,
    );
    expect(created.size).toBe(0);
    expect(code).toBe(0);
  });

  it("reports a malformed command line rather than publishing", async () => {
    const { store, created } = fakeStore(seed());
    expect(await publish(["--nonsense"], store, NOW, suites)).toBe(2);
    expect(created.size).toBe(0);
  });
});

describe("publish() --out", () => {
  const NOW = new Date("2026-08-20T12:00:00.000Z");

  it("writes the manifest and the state it would have created", async () => {
    const out = await Deno.makeTempDir();
    try {
      const { store, created } = fakeStore(seed());
      const code = await publish(
        ["--bootstrap", "--days", "1", "--dry-run", "--out", out],
        store,
        NOW,
        suites,
      );
      expect(code).toBe(0);
      // A dry run creates nothing in the store, and the directory is how
      // the run's answer is looked at instead.
      expect(created.size).toBe(0);

      const manifest = parseManifest(
        await Deno.readTextFile(join(out, "manifest.json")),
      );
      expect(manifest?.entries.length).toBe(1);

      const state = JSON.parse(
        await Deno.readTextFile(join(out, "state.json")),
      );
      expect(Object.keys(state.states).length).toBe(1);
      expect(state.day).toBe("2026-08-20");
    } finally {
      await Deno.remove(out, { recursive: true });
    }
  });

  it("makes the directory when it does not exist yet", async () => {
    const parent = await Deno.makeTempDir();
    try {
      const out = join(parent, "a", "b");
      const { store } = fakeStore(seed());
      expect(
        await publish(
          ["--bootstrap", "--days", "1", "--dry-run", "--out", out],
          store,
          NOW,
          suites,
        ),
      ).toBe(0);
      expect((await Deno.stat(join(out, "manifest.json"))).isFile).toBe(true);
    } finally {
      await Deno.remove(parent, { recursive: true });
    }
  });
});

const ROLLUP = `labs/test-records/aggregated/v1/${DAY}/shard-0.ndjson`;

describe("publish() over a day that has been compacted", () => {
  const NOW = new Date("2026-08-20T12:00:00.000Z");

  it("folds a bootstrap day from its rollup instead of its objects", async () => {
    const read: string[] = [];
    const { store } = fakeStore({
      ...seed(),
      [ROLLUP]: object("c3", "fail", "2026-08-20T03:00:00.000Z"),
    }, { [DAY]: [ROLLUP] });
    const watched: StoreAccess = {
      ...store,
      read: (name) => {
        read.push(name);
        return store.read(name);
      },
    };
    expect(await publish(["--bootstrap", "--days", "1"], watched, NOW, suites))
      .toBe(0);
    expect(read).toEqual([ROLLUP]);
  });

  it("asks nothing about a source and date already settled", async () => {
    // The receipt answers, so the store is not asked at all. It is the
    // rule that decides, rather than which flag the run was given.
    const { store } = fakeStore({
      ...seed(),
      [ROLLUP]: object("c3", "fail", "2026-08-20T03:00:00.000Z"),
    }, { [DAY]: [ROLLUP] });
    await publish(["--bootstrap", "--days", "1"], store, NOW, suites);
    const asked: string[] = [];
    const watched: StoreAccess = {
      ...store,
      rollupShards: (day) => {
        asked.push(day);
        return store.rollupShards(day);
      },
    };
    expect(await publish(["--days", "1"], watched, NOW, suites)).toBe(0);
    expect(asked).toEqual([]);
  });

  it("takes a rollup on an incremental run over a day it has not seen", async () => {
    // One rule, so a run catching up after an outage or a widened window
    // reaches a day the same way a bootstrap does. A flag is permission
    // to start from an empty aggregate and a wider window, not a second
    // way to choose inputs.
    const older = "2026/08/19";
    const olderRollup =
      `labs/test-records/aggregated/v1/${older}/shard-0.ndjson`;
    const { store } = fakeStore({
      ...seed(),
      [CI(older, "9")]: object("c9", "pass", "2026-08-19T01:00:00.000Z"),
      [olderRollup]: object("c9", "pass", "2026-08-19T01:00:00.000Z"),
    }, { [older]: [olderRollup] });
    // The first run's window holds only the newer day, so the older one
    // is a day the aggregate has never seen.
    expect(await publish(["--bootstrap", "--days", "1"], store, NOW, suites))
      .toBe(0);
    const read: string[] = [];
    const watched: StoreAccess = {
      ...store,
      read: (name) => {
        read.push(name);
        return store.read(name);
      },
    };
    expect(await publish(["--days", "2"], watched, NOW, suites)).toBe(0);
    expect(read).toContain(olderRollup);
    expect(read).not.toContain(CI(older, "9"));
  });

  it("stays on the raw path for a day it already holds raw objects from", async () => {
    // A rollup written afterwards would overlap those contributions, and
    // nothing in one of this format says by how much, so the pair that
    // has raw objects in the aggregate keeps taking raw ones.
    const { store } = fakeStore(seed());
    await publish(["--bootstrap", "--days", "1"], store, NOW, suites);
    const read: string[] = [];
    const asked: string[] = [];
    const later: StoreAccess = {
      ...store,
      // The rollup arrives after the raw objects were folded, which is
      // the order compaction runs in.
      rollupShards: (day) => {
        asked.push(day);
        return Promise.resolve(day === DAY ? [ROLLUP] : undefined);
      },
      read: (name) => {
        read.push(name);
        return store.read(name);
      },
    };
    expect(await publish(["--days", "1"], later, NOW, suites)).toBe(0);
    expect(read).not.toContain(ROLLUP);
    // Nor was the store asked: the aggregate already answers for the pair.
    expect(asked).toEqual([]);
  });

  it("still reads the local submissions of a settled day", async () => {
    // Rollups cover the continuous-integration area alone. A receipt
    // naming the day by itself would say the day is accounted for, and
    // the local submissions of that day — the evidence the score weighs
    // highest — would never be read.
    const local = LOCAL(DAY, "ianh");
    const { store } = fakeStore({
      [ROLLUP]: object("c3", "pass", "2026-08-20T03:00:00.000Z"),
      [local]: localObject("c4", "2026-08-20T04:00:00.000Z"),
    }, { [DAY]: [ROLLUP] });
    const read: string[] = [];
    const watched: StoreAccess = {
      ...store,
      read: (name) => {
        read.push(name);
        return store.read(name);
      },
    };
    expect(await publish(["--bootstrap", "--days", "1"], watched, NOW, suites))
      .toBe(0);
    expect(read).toContain(ROLLUP);
    expect(read).toContain(local);
  });

  it("leaves a day open when a shard of its rollup will not read", async () => {
    // Folded half, the day would be marked compacted and the rest of it
    // would be hidden from every later run.
    const objects = {
      ...seed(),
      [ROLLUP]: object("c3", "fail", "2026-08-20T03:00:00.000Z"),
    };
    const { store, created } = fakeStore(objects, {
      [DAY]: [ROLLUP, `labs/test-records/aggregated/v1/${DAY}/shard-1.ndjson`],
    });
    const read: string[] = [];
    const broken: StoreAccess = {
      ...store,
      read: (name) => {
        read.push(name);
        return name.endsWith("shard-1.ndjson")
          ? Promise.reject(new Error("that shard is gone"))
          : store.read(name);
      },
    };
    expect(await publish(["--bootstrap", "--days", "1"], broken, NOW, suites))
      .toBe(0);
    // The run carried on and folded the day's raw objects instead.
    expect(read).toContain(CI(DAY, "1"));
    expect(read).toContain(CI(DAY, "2"));
    expect(created.size).toBeGreaterThan(0);
  });
});

describe("publish() over an aggregate it cannot make sense of", () => {
  const NOW = new Date("2026-08-20T12:00:00.000Z");

  it("refuses rather than starting again from nothing", async () => {
    const { store, created } = fakeStore(seed());
    await publish(["--bootstrap", "--days", "1"], store, NOW, suites);
    const state = [...created.keys()].find((name) => name.includes("/state/"))!;
    const after = created.size;
    const broken: StoreAccess = {
      ...store,
      readText: (name) =>
        name === state
          ? Promise.resolve('{"schema":1,"nonsense":true}')
          : store.readText(name),
    };
    expect(await publish(["--days", "1"], broken, NOW, suites)).toBe(1);
    expect(created.size).toBe(after);
  });
});

describe("writeToken()", () => {
  const NAME = "TEST_RECORDS_GCS_TOKEN";

  /** Runs with the variable set as given, and puts back what was there. */
  function withToken<T>(value: string | undefined, body: () => T): T {
    const before = Deno.env.get(NAME);
    if (value === undefined) Deno.env.delete(NAME);
    else Deno.env.set(NAME, value);
    try {
      return body();
    } finally {
      if (before === undefined) Deno.env.delete(NAME);
      else Deno.env.set(NAME, before);
    }
  }

  it("is the federated token the workflow was given", () => {
    expect(withToken("ya29.a0", writeToken)).toBe("ya29.a0");
  });

  it("is nothing when the variable is unset", () => {
    expect(withToken(undefined, writeToken)).toBeUndefined();
  });

  it("is nothing when the variable is set to empty", () => {
    // A step that failed to mint one leaves the variable set and empty.
    // Read as a token it would reach the store and be refused there.
    expect(withToken("", writeToken)).toBeUndefined();
  });
});

describe("publish() over a store that answers badly", () => {
  const NOW = new Date("2026-08-20T12:00:00.000Z");

  it("refuses when the aggregate object will not read", async () => {
    const { store, created } = fakeStore(seed());
    await publish(["--bootstrap", "--days", "1"], store, NOW, suites);
    const after = created.size;
    const broken: StoreAccess = {
      ...store,
      readText: () => Promise.reject(new Error("that object is gone")),
    };
    expect(await publish(["--days", "1"], broken, NOW, suites)).toBe(1);
    expect(created.size).toBe(after);
  });

  it("refuses when the submissions cannot be listed", async () => {
    const { store, created } = fakeStore(seed());
    await publish(["--bootstrap", "--days", "1"], store, NOW, suites);
    const after = created.size;
    const broken: StoreAccess = {
      ...store,
      list: (prefix) =>
        prefix.includes("/submissions/")
          ? Promise.reject(new Error("the store is unreachable"))
          : store.list(prefix),
    };
    expect(await publish(["--days", "1"], broken, NOW, suites)).toBe(1);
    expect(created.size).toBe(after);
  });
});

describe("publish() reporting what no lane can hold", () => {
  const NOW = new Date("2026-08-20T12:00:00.000Z");

  it("names each one, with the cost the bound was judged against", async () => {
    const slow = (commit: string, at: string) => {
      const body = object(commit, "pass", at);
      // One execution taking longer than a lane's whole hard bound.
      return body.replace('"durationMs":40', '"durationMs":400000');
    };
    const { store } = fakeStore({
      [CI(DAY, "1")]: slow("c1", "2026-08-20T01:00:00.000Z"),
      [CI(DAY, "2")]: slow("c2", "2026-08-20T02:00:00.000Z"),
    });
    const said: string[] = [];
    const log = console.log;
    console.log = (...parts: unknown[]) => said.push(parts.join(" "));
    try {
      expect(await publish(["--bootstrap", "--days", "1"], store, NOW, suites))
        .toBe(0);
    } finally {
      console.log = log;
    }
    const line = said.find((said) => said.includes("unschedulable"));
    expect(line).toBeDefined();
    expect(line).toContain("space > writes");
    expect(line).toContain("400.0s");
  });
});
