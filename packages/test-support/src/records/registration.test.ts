import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";

import {
  activeCapture,
  asDefinition,
  buildCapture,
  fileForName,
  NAME_MAP_PREFIX,
  NAME_MAP_SUFFIX,
  parseSkipList,
  readNameMaps,
  registerFrameworkModule,
  registeringModule,
  relativeToRoot,
  serializeSkipList,
} from "./registration.ts";

// The wrapper's own frame, as it appears in a real registration stack.
const WRAPPER = new URL("./registration.ts", import.meta.url).href;

async function writeNameMap(
  dir: string,
  label: string,
  map: Record<string, unknown>,
): Promise<void> {
  await Deno.writeTextFile(
    join(dir, `${NAME_MAP_PREFIX}${label}${NAME_MAP_SUFFIX}`),
    JSON.stringify(map),
  );
}

describe("registration", () => {
  describe("registeringModule()", () => {
    it("returns the first frame outside the test machinery", () => {
      const stack = [
        "Error",
        `    at Object.test (${WRAPPER}:3:17)`,
        "    at TestSuiteInternal.registerTest (https://jsr.io/@std/testing/" +
        "1.0.20/_test_suite.ts:270:10)",
        "    at describe (https://jsr.io/@std/testing/1.0.20/bdd.ts:1267:22)",
        "    at file:///repo/packages/memory/test/space.test.ts:2:1",
      ].join("\n");
      expect(registeringModule(stack)).toBe(
        "file:///repo/packages/memory/test/space.test.ts",
      );
    });

    it("passes over a module declared as framework machinery", () => {
      registerFrameworkModule(
        "file:///repo/packages/test-support/test/clock.ts",
      );
      const stack = [
        "Error",
        `    at Object.test (${WRAPPER}:3:17)`,
        "    at frozenTest (file:///repo/packages/test-support/test/" +
        "clock.ts:8:5)",
        "    at file:///repo/packages/runner/test/scheduler.test.ts:11:1",
      ].join("\n");
      expect(registeringModule(stack)).toBe(
        "file:///repo/packages/runner/test/scheduler.test.ts",
      );
    });

    it("returns undefined when no frame names a file", () => {
      expect(registeringModule("")).toBeUndefined();
      expect(registeringModule("Error\n    at <anonymous>")).toBeUndefined();
    });
  });

  describe("asDefinition()", () => {
    const body = () => {};

    it("takes a name and a body", () => {
      expect(asDefinition(["a name", body])).toEqual({
        name: "a name",
        fn: body,
      });
    });

    it("keeps the options a name-and-options call carried", () => {
      // Dropping these is the shape that registers a definition with no
      // body, which Deno refuses and which fails the whole module.
      expect(asDefinition(["a name", { sanitizeOps: false }, body])).toEqual({
        name: "a name",
        sanitizeOps: false,
        fn: body,
      });
    });

    it("keeps the options an options-and-body call carried", () => {
      expect(
        asDefinition([{ name: "a name", sanitizeResources: false }, body]),
      ).toEqual({ name: "a name", sanitizeResources: false, fn: body });
    });

    it("names an options-and-body call after its function", () => {
      function namedByItsFunction() {}
      expect(asDefinition([{ ignore: true }, namedByItsFunction])).toEqual({
        name: "namedByItsFunction",
        ignore: true,
        fn: namedByItsFunction,
      });
    });

    it("takes a whole definition as it is", () => {
      const definition = { name: "a name", fn: body, only: true };
      expect(asDefinition([definition])).toBe(definition);
    });

    it("names a bare function after itself", () => {
      function bodyAlone() {}
      expect(asDefinition([bodyAlone])).toEqual({
        name: "bodyAlone",
        fn: bodyAlone,
      });
    });

    it("returns undefined for a shape it does not model", () => {
      // Those reach the real registrar untouched, so Deno reports them.
      expect(asDefinition([])).toBeUndefined();
      expect(asDefinition(["a name"])).toBeUndefined();
      expect(asDefinition([{ sanitizeOps: false }, () => {}])).toBeUndefined();
      expect(asDefinition([42, body])).toBeUndefined();
    });
  });

  describe("relativeToRoot()", () => {
    it("strips the root, with or without its trailing slash", () => {
      expect(
        relativeToRoot("file:///repo/packages/memory/a.test.ts", "/repo"),
      ).toBe("packages/memory/a.test.ts");
      expect(
        relativeToRoot("file:///repo/packages/memory/a.test.ts", "/repo/"),
      ).toBe("packages/memory/a.test.ts");
    });

    it("leaves a path outside the root whole", () => {
      expect(relativeToRoot("file:///elsewhere/a.test.ts", "/repo")).toBe(
        "/elsewhere/a.test.ts",
      );
    });

    it("decodes what the URL escaped", () => {
      expect(relativeToRoot("file:///repo/a%20b/c.test.ts", "/repo")).toBe(
        "a b/c.test.ts",
      );
    });
  });

  describe("fileForName()", () => {
    const names = new Map([
      ["outer", "packages/a/outer.test.ts"],
      ["outer > inner", "packages/a/inner.test.ts"],
      ["bare", "packages/a/bare.test.ts"],
    ]);

    it("returns the file of an exactly registered name", () => {
      expect(fileForName("bare", names)).toBe("packages/a/bare.test.ts");
    });

    it("returns the file of the longest registered prefix", () => {
      expect(fileForName("outer > one", names)).toBe(
        "packages/a/outer.test.ts",
      );
      expect(fileForName("outer > inner > deep", names)).toBe(
        "packages/a/inner.test.ts",
      );
    });

    it("returns undefined for a name no registration covers", () => {
      expect(fileForName("unheard of", names)).toBeUndefined();
      // A prefix without the separator is a different name, not a chain.
      expect(fileForName("outermost", names)).toBeUndefined();
    });
  });

  describe("readNameMaps()", () => {
    it("merges every map a spool holds", async () => {
      const dir = await Deno.makeTempDir();
      try {
        await writeNameMap(dir, "01", { one: "packages/a/one.test.ts" });
        await writeNameMap(dir, "02", { two: "packages/a/two.test.ts" });
        await Deno.writeTextFile(join(dir, "fragment-01.ndjson"), "ignored\n");
        const names = await readNameMaps(dir);
        expect(names.size).toBe(2);
        expect(names.get("one")).toBe("packages/a/one.test.ts");
        expect(names.get("two")).toBe("packages/a/two.test.ts");
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("drops a name two files both claim", async () => {
      const dir = await Deno.makeTempDir();
      try {
        await writeNameMap(dir, "01", {
          shared: "packages/a/one.test.ts",
          own: "packages/a/one.test.ts",
        });
        await writeNameMap(dir, "02", { shared: "packages/b/two.test.ts" });
        const names = await readNameMaps(dir);
        expect(names.get("shared")).toBeUndefined();
        expect(names.get("own")).toBe("packages/a/one.test.ts");
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("judges ambiguity within the scope it was given", async () => {
      // Every package of a workspace run writes into one spool. A name
      // two of them share is unambiguous inside either, so scoping the
      // read is what keeps both their files rather than dropping both.
      const dir = await Deno.makeTempDir();
      try {
        await writeNameMap(dir, "01", {
          shared: "packages/a/one.test.ts",
        });
        await writeNameMap(dir, "02", {
          shared: "packages/b/two.test.ts",
        });
        expect((await readNameMaps(dir)).get("shared")).toBeUndefined();
        expect(
          (await readNameMaps(dir, { within: "packages/a" })).get("shared"),
        ).toBe("packages/a/one.test.ts");
        expect(
          (await readNameMaps(dir, { within: "packages/b/" })).get("shared"),
        ).toBe("packages/b/two.test.ts");
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });

    it("returns an empty map for a spool that is not there", async () => {
      expect((await readNameMaps("/nonexistent-spool")).size).toBe(0);
    });

    it("skips an unparsable map and a line that is not a path", async () => {
      const dir = await Deno.makeTempDir();
      try {
        await Deno.writeTextFile(
          join(dir, `${NAME_MAP_PREFIX}01${NAME_MAP_SUFFIX}`),
          "{not json",
        );
        await writeNameMap(dir, "02", {
          good: "packages/a/one.test.ts",
          bad: 7,
        });
        const names = await readNameMaps(dir);
        expect(names.size).toBe(1);
        expect(names.get("good")).toBe("packages/a/one.test.ts");
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });
  });

  describe("buildCapture()", () => {
    /** A registrar that records what it was handed, running nothing. */
    function recorder() {
      const seen: Deno.TestDefinition[] = [];
      return { seen, registrar: (d: Deno.TestDefinition) => void seen.push(d) };
    }

    it("hands every definition on to the registrar it was given", () => {
      const { seen, registrar } = recorder();
      const built = buildCapture({ registrar });
      built.registrar("a test", () => {});
      built.registrar({ name: "another", sanitizeOps: false }, () => {});
      expect(seen.map((d) => d.name)).toEqual(["a test", "another"]);
      expect(seen[1]!.sanitizeOps).toBe(false);
    });

    it("registers a listed test as ignored rather than dropping it", () => {
      // Dropped, the store watches the identity disappear; ignored, it
      // learns the test was deliberately not run.
      const { seen, registrar } = recorder();
      const built = buildCapture({
        registrar,
        skips: { "packages/a/one.test.ts": ["skip me"] },
      });
      // The file comes from the registration stack, which here is this
      // test file, so nothing matches and the skip does not apply.
      built.registrar("skip me", () => {});
      expect(seen[0]!.ignore).toBeFalsy();
      expect(built.capture.skipped("packages/a/one.test.ts", "skip me")).toBe(
        true,
      );
      expect(built.capture.skipped("packages/a/one.test.ts", "other")).toBe(
        false,
      );
      expect(built.capture.skipped(undefined, "skip me")).toBe(false);
    });

    it("captures the file each registration came from", () => {
      const { registrar } = recorder();
      const built = buildCapture({ registrar });
      built.registrar("named here", () => {});
      // This test file registered it, so that is the file captured.
      expect(built.capture.names.get("named here")).toMatch(
        /registration\.test\.ts$/,
      );
    });

    it("carries ignore and only through their own registrars", () => {
      const { seen, registrar } = recorder();
      const built = buildCapture({ registrar });
      (built.registrar as unknown as {
        ignore: (name: string, fn: () => void) => void;
      }).ignore("ignored", () => {});
      (built.registrar as unknown as {
        only: (name: string, fn: () => void) => void;
      }).only("only this", () => {});
      expect(seen[0]!.ignore).toBe(true);
      expect(seen[1]!.only).toBe(true);
    });

    it("writes the captured map into the spool it was given", async () => {
      const spool = await Deno.makeTempDir();
      try {
        const { registrar } = recorder();
        const built = buildCapture({ registrar, spool });
        built.registrar("written out", () => {});
        built.capture.flush();
        const names = await readNameMaps(spool);
        expect(names.get("written out")).toMatch(/registration\.test\.ts$/);
      } finally {
        await Deno.remove(spool, { recursive: true });
      }
    });

    it("writes nothing when it captured nothing, or has nowhere", () => {
      const { registrar } = recorder();
      // No spool: flushing is a no-op rather than an error.
      buildCapture({ registrar }).capture.flush();
    });
  });

  describe("parseSkipList()", () => {
    it("round-trips what serializeSkipList wrote", () => {
      const skips = { "packages/a/one.test.ts": ["slow > case"] };
      expect(parseSkipList(serializeSkipList(skips))).toEqual(skips);
    });

    it("accepts a list that names nothing", () => {
      expect(parseSkipList("{}")).toEqual({});
    });

    it("returns undefined for anything that is not a skip list", () => {
      expect(parseSkipList("[]")).toBeUndefined();
      expect(parseSkipList("not json")).toBeUndefined();
      expect(parseSkipList('{"a": "b"}')).toBeUndefined();
      expect(parseSkipList('{"a": [1]}')).toBeUndefined();
    });
  });
});

describe("what the capture does with what it cannot read", () => {
  it("leaves a URL it cannot parse alone", () => {
    // The registering module is recovered from a stack trace, which is
    // not always a URL. What is not one is passed through rather than
    // turned into a path that names nothing.
    expect(relativeToRoot("not a url", "/repo")).toBe("not a url");
  });

  it("ignores a name map that is not a map", async () => {
    const dir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(
        join(dir, `${NAME_MAP_PREFIX}01${NAME_MAP_SUFFIX}`),
        "{not json",
      );
      await Deno.writeTextFile(
        join(dir, `${NAME_MAP_PREFIX}02${NAME_MAP_SUFFIX}`),
        '["a name"]',
      );
      await Deno.writeTextFile(
        join(dir, `${NAME_MAP_PREFIX}03${NAME_MAP_SUFFIX}`),
        "null",
      );
      await writeNameMap(dir, "04", { one: "packages/a/one.test.ts" });
      const names = await readNameMaps(dir);
      expect([...names.keys()]).toEqual(["one"]);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  it("drops a mapped file that is not a name", async () => {
    const dir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(
        join(dir, `${NAME_MAP_PREFIX}01${NAME_MAP_SUFFIX}`),
        JSON.stringify({ a: 7, b: "", c: "packages/a/one.test.ts" }),
      );
      const names = await readNameMaps(dir);
      expect([...names.keys()]).toEqual(["c"]);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  it("refuses a skip list that is not an object of lists", () => {
    for (const text of ["{not json", "null", '["a"]', '{"f.ts":"one"}']) {
      expect(parseSkipList(text)).toBeUndefined();
    }
  });
});

describe("activeCapture()", () => {
  it("is nothing in a process that installed no capture", () => {
    // Every invocation that is not recording, which is the one this test
    // runs in: the bdd re-exports consult this and must find nothing.
    expect(activeCapture()).toBeUndefined();
  });
});

describe("the wrapper over a shape it does not model", () => {
  it("hands the real registrar the arguments it was given", () => {
    const seen: unknown[][] = [];
    const built = buildCapture({
      registrar: ((...args: unknown[]) => {
        seen.push(args);
      }) as unknown as typeof Deno.test,
    });
    // No name anywhere, so `asDefinition` recognizes nothing. The call
    // still reaches the registrar, which is what reports its own error.
    (built.registrar as unknown as (...args: unknown[]) => void)(7, 8);
    expect(seen).toEqual([[7, 8]]);
  });
});

describe("what the capture does when it cannot write", () => {
  const registrar = (() => {}) as unknown as typeof Deno.test;

  it("does nothing at all when there is no spool", () => {
    const { capture } = buildCapture({ registrar });
    capture.names.set("a test", "packages/a/one.test.ts");
    // No spool is a run that was never recording, not a failed write.
    capture.flush();
  });

  it("does nothing when it learned no names", async () => {
    const spool = await Deno.makeTempDir();
    try {
      buildCapture({ registrar, spool }).capture.flush();
      expect([...Deno.readDirSync(spool)]).toEqual([]);
    } finally {
      await Deno.remove(spool, { recursive: true });
    }
  });

  it("writes the names it learned into the spool", async () => {
    const spool = await Deno.makeTempDir();
    try {
      const { capture } = buildCapture({ registrar, spool });
      capture.names.set("a test", "packages/a/one.test.ts");
      capture.flush();
      const names = await readNameMaps(spool);
      expect(names.get("a test")).toBe("packages/a/one.test.ts");
    } finally {
      await Deno.remove(spool, { recursive: true });
    }
  });

  it("says so and carries on when the spool cannot be made", async () => {
    // A file where the directory should be. Failing to record must not
    // fail the test run that was recording.
    const parent = await Deno.makeTempDir();
    const spool = join(parent, "in-the-way");
    await Deno.writeTextFile(spool, "");
    const said: string[] = [];
    const warn = console.warn;
    console.warn = (...parts: unknown[]) => said.push(parts.join(" "));
    try {
      const { capture } = buildCapture({ registrar, spool });
      capture.names.set("a test", "packages/a/one.test.ts");
      capture.flush();
    } finally {
      console.warn = warn;
      await Deno.remove(parent, { recursive: true });
    }
    expect(said.join("\n")).toContain("cannot write a name map");
  });
});

describe("the skip list a capture was built with", () => {
  const registrar = (() => {}) as unknown as typeof Deno.test;

  it("skips only the named test in the named file", () => {
    const { capture } = buildCapture({
      registrar,
      skips: { "packages/a/one.test.ts": ["a test"] },
    });
    expect(capture.skipped("packages/a/one.test.ts", "a test")).toBe(true);
    expect(capture.skipped("packages/a/one.test.ts", "another")).toBe(false);
    expect(capture.skipped("packages/a/two.test.ts", "a test")).toBe(false);
  });

  it("skips nothing when the file is unknown", () => {
    // A test whose file could not be recovered cannot be matched against
    // a list keyed by file, so it runs.
    const { capture } = buildCapture({
      registrar,
      skips: { "packages/a/one.test.ts": ["a test"] },
    });
    expect(capture.skipped(undefined, "a test")).toBe(false);
  });

  it("skips nothing when there is no list", () => {
    const { capture } = buildCapture({ registrar });
    expect(capture.skipped("packages/a/one.test.ts", "a test")).toBe(false);
  });
});
