import { expect } from "@std/expect";
import { afterEach, describe, it } from "@std/testing/bdd";
import {
  memberTasks,
  memberTestFiles,
  parseTestTask,
  unquote,
} from "./deno-task.ts";

/** Every directory a case made, removed when the case is done. */
const made: string[] = [];

afterEach(async () => {
  for (const dir of made.splice(0)) {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

/** A member directory holding the manifest and files a case describes. */
async function member(
  manifest: Record<string, unknown>,
  files: readonly string[] = [],
): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "deno-task-" });
  made.push(dir);
  await Deno.writeTextFile(
    `${dir}/deno.json`,
    JSON.stringify(manifest, null, 2),
  );
  for (const file of files) {
    const at = `${dir}/${file}`;
    await Deno.mkdir(at.slice(0, at.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(at, "");
  }
  return dir;
}

describe("reading a member's test task", () => {
  it("takes the flags apart from the paths", () => {
    const parsed = parseTestTask(
      "ENV=test deno test --no-check --allow-read test/*.test.ts",
    );
    expect(parsed?.env).toEqual({ ENV: "test" });
    expect(parsed?.flags).toEqual(["--no-check", "--allow-read"]);
    expect(parsed?.paths).toEqual(["test/*.test.ts"]);
  });

  it("collects every --ignore separately from the flags", () => {
    const parsed = parseTestTask(
      "deno test --allow-read --ignore='a.test.ts,b/**' .",
    );
    expect(parsed?.ignores).toEqual(["a.test.ts", "b/**"]);
    expect(parsed?.flags).toEqual(["--allow-read"]);
  });

  it("resolves the execPath substitution rather than refusing it", () => {
    const parsed = parseTestTask(
      'deno test --allow-run=$(deno eval "console.log(Deno.execPath())")',
      "/usr/bin/deno",
    );
    expect(parsed?.flags).toEqual(["--allow-run=/usr/bin/deno"]);
  });

  it("strips shell quoting from inside a flag's value", () => {
    // Several members write `--allow-env=API_URL,"TSC_*",NODE_ENV`. The
    // quotes are the shell's; a flag passed through with them names a
    // permission with literal quote characters, which matches nothing.
    const parsed = parseTestTask(
      'deno test --allow-env=API_URL,"TSC_*",NODE_ENV test/a.test.ts',
    );
    expect(parsed?.flags).toEqual(["--allow-env=API_URL,TSC_*,NODE_ENV"]);
    expect(unquote('a,"b",c')).toBe("a,b,c");
  });

  it("refuses a task that is two commands", () => {
    expect(parseTestTask("deno test a.test.ts && deno run b.ts"))
      .toBeUndefined();
  });

  it("refuses a task naming its own import map", () => {
    // That map governs every module of the invocation, the preload
    // included, so a specifier the preload needs and the map does not
    // carry would fail the whole run rather than the preload alone.
    expect(parseTestTask("deno test -A --import-map ./map.json .")).toBe(
      undefined,
    );
  });

  it("refuses a task that is not a deno test at all", () => {
    expect(parseTestTask("deno run test/runner.ts")).toBeUndefined();
    expect(parseTestTask("echo 'No tests defined.'")).toBeUndefined();
  });
});

describe("listing a member's test files", () => {
  it("walks a directory the way deno test walks one", async () => {
    const dir = await member({}, [
      "test/one.test.ts",
      "test/nested/two.test.tsx",
      "test/helper.ts",
      "src/three_test.ts",
    ]);
    const files = await memberTestFiles(dir, parseTestTask("deno test .")!);
    expect(files).toEqual([
      "src/three_test.ts",
      "test/nested/two.test.tsx",
      "test/one.test.ts",
    ]);
  });

  it("applies the task's --ignore, which an explicit path would not", async () => {
    const dir = await member({}, [
      "test/one.test.ts",
      "test/browser/two.browser.test.ts",
    ]);
    const files = await memberTestFiles(
      dir,
      parseTestTask("deno test --ignore='test/browser' .")!,
    );
    expect(files).toEqual(["test/one.test.ts"]);
  });

  it("applies the member's own exclude", async () => {
    const dir = await member({ test: { exclude: ["integration"] } }, [
      "test/one.test.ts",
      "integration/two.test.ts",
    ]);
    const files = await memberTestFiles(dir, parseTestTask("deno test .")!);
    expect(files).toEqual(["test/one.test.ts"]);
  });

  it("keeps a file the task names outright, whatever it is called", async () => {
    // The naming rule is how Deno decides what to run when it discovers
    // files for itself. A path somebody wrote down is one the task runs.
    const dir = await member({}, ["test/scenarios.ts", "test/one.test.ts"]);
    const files = await memberTestFiles(
      dir,
      parseTestTask("deno test test/scenarios.ts")!,
    );
    expect(files).toEqual(["test/scenarios.ts"]);
  });

  it("raises an error that is not a missing directory", async () => {
    // Swallowing one would quietly shorten the list of tests, which is
    // the failure the whole topology exists to make impossible.
    const dir = await member({}, ["test/one.test.ts"]);
    await Deno.chmod(`${dir}/test`, 0o000);
    try {
      await expect(
        memberTestFiles(dir, parseTestTask("deno test .")!),
      ).rejects.toThrow();
    } finally {
      await Deno.chmod(`${dir}/test`, 0o755);
    }
  });

  it("expands a glob the task names", async () => {
    const dir = await member({}, [
      "test/one.test.ts",
      "test/nested/two.test.ts",
    ]);
    const files = await memberTestFiles(
      dir,
      parseTestTask("deno test test/*.test.ts")!,
    );
    expect(files).toEqual(["test/one.test.ts"]);
  });
});

describe("resolving which task a member's tests run through", () => {
  it("prefers the Deno-only half where a member names one", async () => {
    const dir = await member({
      tasks: {
        test: { dependencies: ["deno-test", "browser-test"] },
        "deno-test": "deno test --allow-read test/*.test.ts",
        "browser-test": "deno run -A ../deno-web-test/cli.ts test/*.test.ts",
      },
    });
    const tasks = await memberTasks(dir);
    expect(tasks.denoTestTask).toBe("deno-test");
    expect(tasks.browserTest).toBe(true);
  });

  it("reaches through a task written as a dependency list", async () => {
    const dir = await member({
      tasks: {
        check: "deno check .",
        "just-test": { command: "deno test --allow-read" },
        test: { dependencies: ["check", "just-test"] },
      },
    });
    const tasks = await memberTasks(dir);
    expect(tasks.denoTestTask).toBe("just-test");
    expect(tasks.denoTest?.flags).toEqual(["--allow-read"]);
  });

  it("reports a member whose task cannot be handed a subset", async () => {
    const dir = await member({
      tasks: { test: "deno run --allow-read test/run-tests.ts" },
    });
    const tasks = await memberTasks(dir);
    expect(tasks.present).toBe(true);
    expect(tasks.denoTest).toBeUndefined();
  });

  it("keeps a member whose only tests need a browser", async () => {
    const dir = await member({
      tasks: {
        "browser-test": "deno run -A ../deno-web-test/cli.ts a.test.ts",
      },
    });
    const tasks = await memberTasks(dir);
    expect(tasks.present).toBe(true);
    expect(tasks.browserTest).toBe(true);
  });

  it("reports a member that says it has no tests as no surface", async () => {
    const dir = await member({ tasks: { test: "echo 'No tests defined.'" } });
    expect((await memberTasks(dir)).present).toBe(false);
  });
});
