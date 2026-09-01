/**
 * The registration preload, exercised the way a test job exercises it: a
 * real `deno test` run over fixture files, with the preload loaded and a
 * skip list in place. What this proves cannot be proven in-process,
 * because installing the capture replaces `Deno.test` for good.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { assert } from "@std/assert";
import { join } from "@std/path";
import {
  dropContainerCases,
  ingestJUnit,
  parseJUnit,
  preloadModulePath,
  readNameMaps,
  serializeSkipList,
  type SkipList,
} from "../../src/records/mod.ts";

/**
 * The imports a fixture tree needs to resolve the preload's own modules.
 * `@std/testing/bdd` points at this repository's re-export exactly as the
 * root import map does, so a fixture exercises the wrapper a real test
 * file goes through rather than the module underneath it.
 */
const FIXTURE_CONFIG = {
  imports: {
    "@std/path": "jsr:@std/path@^1.1.6",
    "@std/testing": "jsr:@std/testing@^1.0.19",
    "@std/testing/bdd": new URL("../../src/records/bdd.ts", import.meta.url)
      .href,
    "@std/testing/bdd/real": "jsr:@std/testing@^1.0.19/bdd",
    "@std/ulid": "jsr:@std/ulid@^1.0.0",
  },
};

interface Fixture {
  dir: string;
  spool: string;
  junit: string;
}

/**
 * A tree that looks like a repository to the preload: the `.git` marker is
 * what it climbs to, so a fixture needs one and needs nothing else.
 */
async function makeFixture(files: Record<string, string>): Promise<Fixture> {
  const dir = await Deno.makeTempDir({ prefix: "preload-fixture-" });
  await Deno.mkdir(join(dir, ".git"));
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify(FIXTURE_CONFIG),
  );
  for (const [name, source] of Object.entries(files)) {
    await Deno.writeTextFile(join(dir, name), source);
  }
  const spool = join(dir, "spool");
  await Deno.mkdir(spool);
  return { dir, spool, junit: join(dir, "report.xml") };
}

async function runFixture(
  fixture: Fixture,
  files: readonly string[],
  skips?: SkipList,
): Promise<Deno.CommandOutput> {
  const env: Record<string, string> = {
    CF_TEST_RECORDS_DIR: fixture.spool,
  };
  if (skips !== undefined) {
    const path = join(fixture.dir, "skips.json");
    await Deno.writeTextFile(path, serializeSkipList(skips));
    env.CF_TEST_SKIP_LIST = path;
  }
  return await new Deno.Command(Deno.execPath(), {
    args: [
      "test",
      "--quiet",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      `--preload=${preloadModulePath()}`,
      `--junit-path=${fixture.junit}`,
      ...files,
    ],
    cwd: fixture.dir,
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
}

/** The leaf cases a run reported, by name, with their outcomes. */
async function outcomes(
  fixture: Fixture,
): Promise<Map<string, "pass" | "fail" | "skip">> {
  const xml = await Deno.readTextFile(fixture.junit);
  const leaves = dropContainerCases(parseJUnit(xml));
  return new Map(leaves.map((leaf) => [leaf.name, leaf.outcome]));
}

const BDD_FILE = `import { describe, it } from "@std/testing/bdd";
describe("outer", () => {
  it("kept", () => {});
  it("dropped", () => {});
});
`;

const NESTED_BDD_FILE = `import { describe, it } from "@std/testing/bdd";
describe("outer", () => {
  describe("inner", () => {
    it("kept", () => {});
    it("dropped", () => {});
  });
});
`;

const ADDED_LEAF_FILE = `import { describe, it } from "@std/testing/bdd";
describe("outer", () => {
  it("kept", () => {});
  it("dropped", () => {});
  it("added later", () => {});
});
`;

const OTHER_BDD_FILE = `import { describe, it } from "@std/testing/bdd";
describe("elsewhere", () => {
  it("dropped", () => {});
});
`;

const BARE_FILE = `Deno.test("bare kept", () => {});
Deno.test("bare dropped", () => {});
`;

// Every way `Deno.test` can be called. The options forms carry the
// sanitizer settings a test needs, and they put the body in the second or
// third argument, so a wrapper that reads only the first two registers a
// definition with no body and Deno refuses the whole module.
const OVERLOAD_FILE = `Deno.test("name and body", () => {});
Deno.test("name, options and body", { sanitizeOps: false }, () => {});
Deno.test({ name: "whole definition", fn: () => {} });
Deno.test({ name: "options and body", sanitizeResources: false }, () => {});
Deno.test({ sanitizeOps: false }, function namedByItsFunction() {});
Deno.test(function bodyAlone() {});
`;

describe("preload", () => {
  it("records the file each test was registered from", async () => {
    const fixture = await makeFixture({
      "bdd.test.ts": BDD_FILE,
      "bare.test.ts": BARE_FILE,
    });
    try {
      const run = await runFixture(fixture, ["bdd.test.ts", "bare.test.ts"]);
      assert(run.success, new TextDecoder().decode(run.stderr));
      const names = await readNameMaps(fixture.spool);
      expect(names.get("outer")).toEqual("bdd.test.ts");
      expect(names.get("bare kept")).toEqual("bare.test.ts");
      expect(names.get("bare dropped")).toEqual("bare.test.ts");

      // The join ingestion performs: a leaf named as its describe chain
      // takes the file its top-level registration came from.
      const records = ingestJUnit(await Deno.readTextFile(fixture.junit), {
        kind: "unit",
        scope: "fixture",
        fileByName: names,
      });
      const byName = new Map(records.map((r) => [r.test.n, r.file]));
      expect(byName.get("outer > kept")).toEqual("bdd.test.ts");
      expect(byName.get("bare kept")).toEqual("bare.test.ts");
    } finally {
      await Deno.remove(fixture.dir, { recursive: true });
    }
  });

  it("registers every way `Deno.test` can be called", async () => {
    const fixture = await makeFixture({ "overloads.test.ts": OVERLOAD_FILE });
    try {
      const run = await runFixture(fixture, ["overloads.test.ts"]);
      assert(run.success, new TextDecoder().decode(run.stderr));
      const reported = await outcomes(fixture);
      expect([...reported.keys()].sort()).toEqual([
        "bodyAlone",
        "name and body",
        "name, options and body",
        "namedByItsFunction",
        "options and body",
        "whole definition",
      ].sort());
      for (const outcome of reported.values()) expect(outcome).toEqual("pass");
      // That each form registers and runs. That the options it carried
      // reach the definition is asserted directly against `asDefinition`
      // in registration.test.ts: Deno's sanitizers do not fire on a leak
      // these bodies could stage, so no outcome here would differ.
      const names = await readNameMaps(fixture.spool);
      expect(names.get("name, options and body")).toEqual("overloads.test.ts");
      expect(names.get("options and body")).toEqual("overloads.test.ts");
      expect(names.get("namedByItsFunction")).toEqual("overloads.test.ts");
    } finally {
      await Deno.remove(fixture.dir, { recursive: true });
    }
  });

  it("skips a listed test whichever way it was registered", async () => {
    const fixture = await makeFixture({ "overloads.test.ts": OVERLOAD_FILE });
    try {
      const run = await runFixture(fixture, ["overloads.test.ts"], {
        "overloads.test.ts": ["name, options and body", "options and body"],
      });
      assert(run.success, new TextDecoder().decode(run.stderr));
      const reported = await outcomes(fixture);
      expect(reported.get("name, options and body")).toEqual("skip");
      expect(reported.get("options and body")).toEqual("skip");
      expect(reported.get("whole definition")).toEqual("pass");
    } finally {
      await Deno.remove(fixture.dir, { recursive: true });
    }
  });

  it("reports a listed test as skipped rather than missing", async () => {
    const fixture = await makeFixture({ "bare.test.ts": BARE_FILE });
    try {
      const run = await runFixture(fixture, ["bare.test.ts"], {
        "bare.test.ts": ["bare dropped"],
      });
      assert(run.success, new TextDecoder().decode(run.stderr));
      const reported = await outcomes(fixture);
      expect(reported.get("bare kept")).toEqual("pass");
      expect(reported.get("bare dropped")).toEqual("skip");
    } finally {
      await Deno.remove(fixture.dir, { recursive: true });
    }
  });

  it("runs an unlisted test whatever the list says of its neighbours", async () => {
    const fixture = await makeFixture({
      "bare.test.ts": BARE_FILE + `Deno.test("added later", () => {});\n`,
    });
    try {
      const run = await runFixture(fixture, ["bare.test.ts"], {
        "bare.test.ts": ["bare kept", "bare dropped"],
      });
      assert(run.success, new TextDecoder().decode(run.stderr));
      const reported = await outcomes(fixture);
      expect(reported.get("added later")).toEqual("pass");
      expect(reported.get("bare kept")).toEqual("skip");
    } finally {
      await Deno.remove(fixture.dir, { recursive: true });
    }
  });

  it("skips one leaf of a file by its whole describe chain", async () => {
    const fixture = await makeFixture({ "bdd.test.ts": BDD_FILE });
    try {
      const run = await runFixture(fixture, ["bdd.test.ts"], {
        "bdd.test.ts": ["outer > dropped"],
      });
      assert(run.success, new TextDecoder().decode(run.stderr));
      const reported = await outcomes(fixture);
      expect(reported.get("outer > kept")).toEqual("pass");
      expect(reported.get("outer > dropped")).toEqual("skip");
    } finally {
      await Deno.remove(fixture.dir, { recursive: true });
    }
  });

  it("names a nested leaf by the whole chain that encloses it", async () => {
    const fixture = await makeFixture({ "nested.test.ts": NESTED_BDD_FILE });
    try {
      const run = await runFixture(fixture, ["nested.test.ts"], {
        "nested.test.ts": ["outer > inner > dropped"],
      });
      assert(run.success, new TextDecoder().decode(run.stderr));
      const reported = await outcomes(fixture);
      expect(reported.get("outer > inner > kept")).toEqual("pass");
      expect(reported.get("outer > inner > dropped")).toEqual("skip");
    } finally {
      await Deno.remove(fixture.dir, { recursive: true });
    }
  });

  it("skips independently in two files holding the same leaf name", async () => {
    const fixture = await makeFixture({
      "bdd.test.ts": BDD_FILE,
      "other.test.ts": OTHER_BDD_FILE,
    });
    try {
      const run = await runFixture(fixture, ["bdd.test.ts", "other.test.ts"], {
        "bdd.test.ts": ["outer > dropped"],
      });
      assert(run.success, new TextDecoder().decode(run.stderr));
      const reported = await outcomes(fixture);
      expect(reported.get("outer > dropped")).toEqual("skip");
      expect(reported.get("elsewhere > dropped")).toEqual("pass");
    } finally {
      await Deno.remove(fixture.dir, { recursive: true });
    }
  });

  it("runs an unlisted leaf a pull request just added", async () => {
    const fixture = await makeFixture({
      "bdd.test.ts": ADDED_LEAF_FILE,
    });
    try {
      const run = await runFixture(fixture, ["bdd.test.ts"], {
        "bdd.test.ts": ["outer > kept", "outer > dropped"],
      });
      assert(run.success, new TextDecoder().decode(run.stderr));
      const reported = await outcomes(fixture);
      expect(reported.get("outer > added later")).toEqual("pass");
      expect(reported.get("outer > kept")).toEqual("skip");
    } finally {
      await Deno.remove(fixture.dir, { recursive: true });
    }
  });

  it("runs a renamed test, since the new name is not the old", async () => {
    const fixture = await makeFixture({
      "bare.test.ts": `Deno.test("the new name", () => {});\n`,
    });
    try {
      const run = await runFixture(fixture, ["bare.test.ts"], {
        "bare.test.ts": ["the old name"],
      });
      assert(run.success, new TextDecoder().decode(run.stderr));
      expect((await outcomes(fixture)).get("the new name")).toEqual("pass");
    } finally {
      await Deno.remove(fixture.dir, { recursive: true });
    }
  });

  it("skips one file's copy of a shared test name and not the other", async () => {
    const shared = `Deno.test("shared name", () => {});\n`;
    const fixture = await makeFixture({
      "one.test.ts": shared,
      "two.test.ts": shared,
    });
    try {
      const run = await runFixture(fixture, ["one.test.ts", "two.test.ts"], {
        "one.test.ts": ["shared name"],
      });
      assert(run.success, new TextDecoder().decode(run.stderr));
      // The report names both by the same identity, so the pair is one
      // passed case and one skipped one under that name.
      const xml = await Deno.readTextFile(fixture.junit);
      const leaves = dropContainerCases(parseJUnit(xml))
        .filter((leaf) => leaf.name === "shared name")
        .map((leaf) => leaf.outcome)
        .sort();
      expect(leaves).toEqual(["pass", "skip"]);
    } finally {
      await Deno.remove(fixture.dir, { recursive: true });
    }
  });

  it("leaves the report alone when it has nothing to do", async () => {
    const fixture = await makeFixture({
      "bdd.test.ts": BDD_FILE,
      "bare.test.ts": BARE_FILE,
    });
    try {
      // No write permission and no skip list, so `Deno.test` is left
      // alone and a bare test keeps its own class name. A bdd file's
      // class name is the module its `describe` came from, which is the
      // repository's own re-export, so ingestion declines it and the
      // leaf has no file: the preload's name map is what supplies one,
      // and this run wrote none.
      const run = await new Deno.Command(Deno.execPath(), {
        args: [
          "test",
          "--quiet",
          "--allow-read",
          "--allow-env",
          `--preload=${preloadModulePath()}`,
          `--junit-path=${fixture.junit}`,
          "bdd.test.ts",
          "bare.test.ts",
        ],
        cwd: fixture.dir,
        env: { CF_TEST_RECORDS_DIR: fixture.spool },
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert(run.success, new TextDecoder().decode(run.stderr));
      expect((await readNameMaps(fixture.spool)).size).toEqual(0);
      const records = ingestJUnit(await Deno.readTextFile(fixture.junit), {
        kind: "unit",
        scope: "fixture",
        filePrefix: "",
      });
      const byName = new Map(records.map((r) => [r.test.n, r.file]));
      expect(byName.get("outer > kept")).toBeUndefined();
      expect(byName.get("bare kept")).toEqual("bare.test.ts");
    } finally {
      await Deno.remove(fixture.dir, { recursive: true });
    }
  });

  it("runs everything when the skip list is malformed", async () => {
    const fixture = await makeFixture({ "bare.test.ts": BARE_FILE });
    try {
      const path = join(fixture.dir, "skips.json");
      await Deno.writeTextFile(path, "not a skip list");
      const run = await new Deno.Command(Deno.execPath(), {
        args: [
          "test",
          "--quiet",
          "--allow-read",
          "--allow-write",
          "--allow-env",
          `--preload=${preloadModulePath()}`,
          `--junit-path=${fixture.junit}`,
          "bare.test.ts",
        ],
        cwd: fixture.dir,
        env: { CF_TEST_RECORDS_DIR: fixture.spool, CF_TEST_SKIP_LIST: path },
        stdout: "piped",
        stderr: "piped",
      }).output();
      assert(run.success, new TextDecoder().decode(run.stderr));
      const reported = await outcomes(fixture);
      expect(reported.get("bare kept")).toEqual("pass");
      expect(reported.get("bare dropped")).toEqual("pass");
    } finally {
      await Deno.remove(fixture.dir, { recursive: true });
    }
  });
});
