import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Command } from "@cliffy/command";
import { dirname, fromFileUrl, join } from "@std/path";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";
import {
  commandPattern,
  declaredCommands,
  describeCommandDocFailures,
  documentedCommands,
  isLiveDoc,
  main,
  NO_PROSE,
  readPackageDocs,
  reportCommandDocs,
} from "./check-command-docs.ts";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

/** Run the gate the way its task does, and return what the process reported. */
async function runAsProgram(
  ...args: string[]
): Promise<{ code: number; out: string }> {
  const output = await runDenoCommandWithTemporaryLock({
    root: REPO_ROOT,
    args: (lockPath) => [
      "run",
      "--config",
      join(REPO_ROOT, "deno.jsonc"),
      "--lock",
      lockPath,
      // The permissions deno.jsonc grants the task, so a run that needs more
      // than the task allows fails here rather than in CI.
      "--allow-read",
      "--allow-env",
      "--allow-sys",
      "--allow-ffi",
      join(REPO_ROOT, "tasks/check-command-docs.ts"),
      ...args,
    ],
  });
  return { code: output.code, out: new TextDecoder().decode(output.stdout) };
}

/** What a run printed, either side of the exit code it returned. */
async function captureConsole(
  body: () => Promise<number>,
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args) => out.push(args.map(String).join(" "));
  console.error = (...args) => err.push(args.map(String).join(" "));
  try {
    return { code: await body(), out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}

/**
 * A repository root holding a config and no documents at all, so every
 * command the CLI declares is undocumented and the failure directions are
 * reachable without inventing a command tree.
 */
async function withEmptyRoot(
  body: (root: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${root}/deno.jsonc`, `{ "workspace": [] }`);
    await body(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

/** The gate's own failure verdict, run against a root with no documents. */
async function withFailure(): Promise<
  { code: number; out: string; err: string }
> {
  let captured = { code: -1, out: "", err: "" };
  await withEmptyRoot(async (root) => {
    captured = await captureConsole(() => main([], root));
  });
  return captured;
}

/** A small tree in the shape the CLI's own is: nested commands under a root. */
function fixtureTree() {
  return new Command()
    .name("cf")
    .command("brew", new Command().description("make a donut glaze"))
    .command(
      "glaze",
      new Command()
        .description("apply one")
        .command("set", new Command().description("choose a flavor"))
        .command("setsrc", new Command().description("a different command")),
    );
}

describe("check-command-docs", () => {
  describe("declaredCommands()", () => {
    it("names every command by the path a caller types", () => {
      expect(declaredCommands(fixtureTree())).toEqual([
        "brew",
        "glaze",
        "glaze set",
        "glaze setsrc",
      ]);
    });

    it("returns no entry for the help cliffy propagates to every command", () => {
      // It is generated onto every descendant, so it is nobody's command and
      // no document owes it prose.

      const tree = new Command().name("cf").command(
        "brew",
        new Command().description("d"),
      );
      expect(declaredCommands(tree)).not.toContain("help");
    });

    it("names a hidden command, which a caller reaches like any other", () => {
      // Hidden decides what `--help` prints, not what the CLI accepts: the
      // real tree hides `completion complete` and every installed completion
      // function invokes it on every Tab. A gate that walked past it would
      // report a count having never asked about the last command.

      const tree = new Command()
        .name("cf")
        .command("brew", new Command().description("make a glaze"))
        .command(
          "sift",
          new Command().description("an entry point nobody types").hidden(),
        );
      expect(declaredCommands(tree)).toEqual(["brew", "sift"]);
    });

    it("walks into a hidden command's own subcommands", () => {
      // The hidden one is a group in the real tree, and its child is the
      // command that actually runs.

      const tree = new Command().name("cf").command(
        "completion",
        new Command()
          .description("shell completion")
          .command(
            "complete",
            new Command().description("what the shell calls").hidden(),
          )
          .hidden(),
      );
      expect(declaredCommands(tree)).toEqual([
        "completion",
        "completion complete",
      ]);
    });
  });

  describe("isLiveDoc()", () => {
    /** One package, the way the root config names its members. */
    const packageDocs = new Set(["packages/oven/README.md"]);

    it("reads a path spelled with either separator", () => {
      // The rules are written in slashes and the path arrives in the host's
      // separator, so a Windows spelling has to reach the same verdict.

      expect(isLiveDoc("docs/guide.md", packageDocs)).toBe(true);
      expect(isLiveDoc("docs\\guide.md", packageDocs)).toBe(true);
      expect(isLiveDoc("docs/history/report.md", packageDocs)).toBe(false);
      expect(isLiveDoc("docs\\history\\report.md", packageDocs)).toBe(false);
      expect(isLiveDoc("docs\\plans\\later.md", packageDocs)).toBe(false);
      expect(isLiveDoc("packages\\oven\\brew.ts", packageDocs)).toBe(false);
      expect(isLiveDoc("packages\\oven\\README.md", packageDocs)).toBe(true);
    });

    it("takes nothing vendored under node_modules as documentation", () => {
      // A dependency's own README travels with the dependency. Without this
      // rule a vendored copy under `docs/` would read as live documentation,
      // and a command named in it would satisfy the gate.

      expect(isLiveDoc("docs/node_modules/dep/README.md", packageDocs))
        .toBe(false);
      expect(isLiveDoc("skills/cf/node_modules/dep/guide.md", packageDocs))
        .toBe(false);
      // The rule is the path segment, not the word: a document about the
      // directory is still a document.
      expect(isLiveDoc("docs/node_modules-and-you.md", packageDocs)).toBe(true);
    });

    it("takes a README under a package to be the package's own or nothing", () => {
      // A fixture corpus and a test directory keep READMEs of their own, and
      // neither is somewhere a caller is sent to read.

      expect(isLiveDoc("packages/oven/README.md", packageDocs)).toBe(true);
      expect(isLiveDoc("packages/oven/test/README.md", packageDocs))
        .toBe(false);
      expect(isLiveDoc("packages/oven/test/fixtures/README.md", packageDocs))
        .toBe(false);
      // A member the config names below the first level is still a package.
      expect(
        isLiveDoc("packages/mixers/whisk/README.md", packageDocs),
      ).toBe(false);
      expect(
        isLiveDoc(
          "packages/mixers/whisk/README.md",
          new Set(["packages/mixers/whisk/README.md"]),
        ),
      ).toBe(true);
    });
  });

  describe("readPackageDocs()", () => {
    it("names one README per workspace member, however deep", async () => {
      const root = await Deno.makeTempDir();
      try {
        await Deno.writeTextFile(
          `${root}/deno.jsonc`,
          `{
  // The member list is what says a directory is a package.
  "workspace": ["./packages/oven", "./packages/mixers/whisk"]
}`,
        );
        expect([...await readPackageDocs(root)].sort()).toEqual([
          "packages/mixers/whisk/README.md",
          "packages/oven/README.md",
        ]);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("takes no README from a config that lists no workspace", async () => {
      // A config without the key is not a config with an empty one by
      // accident: no member means no package README counts, and the walk
      // simply finds nothing under `packages/`.

      const root = await Deno.makeTempDir();
      try {
        await Deno.writeTextFile(`${root}/deno.jsonc`, `{ "tasks": {} }`);
        expect([...await readPackageDocs(root)]).toEqual([]);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("skips a member that is not a path", async () => {
      // The member list is data from a file, so a malformed entry is a
      // possibility rather than a type error. It contributes no README
      // instead of a `[object Object]/README.md` that matches nothing.

      const root = await Deno.makeTempDir();
      try {
        await Deno.writeTextFile(
          `${root}/deno.jsonc`,
          `{ "workspace": ["./packages/oven", 7, { "path": "./packages/x" }] }`,
        );
        expect([...await readPackageDocs(root)]).toEqual([
          "packages/oven/README.md",
        ]);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });
  });

  describe("commandPattern()", () => {
    const commands = ["brew", "glaze", "glaze set", "glaze setsrc"];

    it("needs a boundary before the command as well as after it", () => {
      // Otherwise a word ending in the command's letters names it.

      expect(commandPattern("brew", commands).test("Run `cf brew`.")).toBe(
        true,
      );
      expect(commandPattern("brew", commands).test("Run scf brew.")).toBe(
        false,
      );
      expect(commandPattern("brew", commands).test("Run my-cf brew.")).toBe(
        false,
      );
    });

    it("does not let a child stand in for the parent it hangs under", () => {
      // A reader looking up `cf glaze` finds nothing about it in a document
      // that only ever writes `cf glaze set`.

      const glaze = commandPattern("glaze", commands);
      expect(glaze.test("Run `cf glaze set` first.")).toBe(false);
      expect(glaze.test("Run `cf glaze setsrc` first.")).toBe(false);
      expect(glaze.test("`cf glaze` applies one.")).toBe(true);
      // An argument is not a child, so it still reads as naming the parent.
      expect(glaze.test("Run `cf glaze cherry`.")).toBe(true);
    });
  });

  describe("documentedCommands()", () => {
    /** A throwaway tree of documents, so the search runs against real files. */
    async function withDocs(
      files: Record<string, string>,
      body: (root: string) => Promise<void>,
    ): Promise<void> {
      const root = await Deno.makeTempDir();
      try {
        // The package rule reads its member list from the root config, so a
        // throwaway tree needs one the way the repository has one.
        await Deno.writeTextFile(
          `${root}/deno.jsonc`,
          `{ "workspace": ["./packages/oven"] }`,
        );
        for (const [path, text] of Object.entries(files)) {
          const full = `${root}/${path}`;
          await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), {
            recursive: true,
          });
          await Deno.writeTextFile(full, text);
        }
        await body(root);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    }

    it("finds a command a live document names", async () => {
      await withDocs({ "docs/guide.md": "Run `cf glaze set` first." }, async (
        root,
      ) => {
        expect([...await documentedCommands(root, ["glaze set"])])
          .toEqual(["glaze set"]);
      });
    });

    it("does not let a longer command satisfy a shorter one", async () => {
      // `cf glaze setsrc` is its own command with its own obligation, so it
      // must not stand in for `cf glaze set`.

      await withDocs({ "docs/guide.md": "Run `cf glaze setsrc`." }, async (
        root,
      ) => {
        expect([...await documentedCommands(root, ["glaze set"])]).toEqual([]);
      });
    });

    it("reads a mention the document wrapped across lines", async () => {
      await withDocs({ "docs/guide.md": "Run `cf glaze\nset` first." }, async (
        root,
      ) => {
        expect([...await documentedCommands(root, ["glaze set"])])
          .toEqual(["glaze set"]);
      });
    });

    it("ignores a record of a moment rather than a description", async () => {
      // A command named only in an archived report or a pending plan is not
      // documented: neither describes a surface a reader can use today.

      await withDocs({
        "docs/history/report.md": "We ran `cf brew` in July.",
        "docs/plans/later.md": "`cf brew` will gain a flag.",
      }, async (root) => {
        expect([...await documentedCommands(root, ["brew"])]).toEqual([]);
      });
    });

    it("does not take an instruction written for an agent as documentation", async () => {
      // `.claude/` addresses one agent mid-task. A command it is told to run
      // is still a command no caller can look up, so it covers nothing.

      await withDocs({
        ".claude/agents/baker.md": "Run `cf brew` before you glaze.",
        "skills/baking/SKILL.md": "`cf glaze set` picks the flavor.",
      }, async (root) => {
        const found = await documentedCommands(root, ["brew", "glaze set"]);
        expect([...found]).toEqual(["glaze set"]);
      });
    });

    it("reads a package README and not the source beside it", async () => {
      await withDocs({
        "packages/oven/README.md": "`cf brew` heats the glaze.",
        "packages/oven/brew.ts": "// `cf glaze set` in a comment",
      }, async (root) => {
        const found = await documentedCommands(root, ["brew", "glaze set"]);
        expect([...found]).toEqual(["brew"]);
      });
    });

    it("raises a doc root that cannot be walked rather than reading past it", async () => {
      // A missing root contributes no documents, which is how a partial
      // checkout behaves. A root that exists and cannot be walked is a
      // different fact: reading past it would silently drop every document
      // it holds and report the commands they name as undocumented.

      const root = await Deno.makeTempDir();
      try {
        await Deno.writeTextFile(`${root}/deno.jsonc`, `{ "workspace": [] }`);
        await Deno.writeTextFile(`${root}/docs`, "a file where a tree goes");
        await expect(documentedCommands(root, ["brew"])).rejects.toThrow(
          /Not a directory/,
        );
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("reads the package's own README and not an internal one", async () => {
      // A fixture corpus documents the fixtures, for whoever maintains them.

      await withDocs({
        "packages/oven/README.md": "`cf brew` heats the glaze.",
        "packages/oven/test/fixtures/README.md": "`cf glaze set` here too.",
      }, async (root) => {
        const found = await documentedCommands(root, ["brew", "glaze set"]);
        expect([...found]).toEqual(["brew"]);
      });
    });
  });

  describe("reportCommandDocs()", () => {
    const declared = ["brew", "glaze set"];

    it("names a command no document covers and no allowance excuses", () => {
      const report = reportCommandDocs(declared, new Set(), new Map());
      expect(report.undocumented).toEqual(["brew", "glaze set"]);
    });

    it("returns no finding for a documented command", () => {
      expect(
        reportCommandDocs(declared, new Set(declared), new Map()).undocumented,
      ).toEqual([]);
    });

    it("returns no finding for a command the allowance records a reason for", () => {
      const allowed = new Map([["brew", "an internal entry point"]]);
      expect(
        reportCommandDocs(declared, new Set(["glaze set"]), allowed)
          .undocumented,
      ).toEqual([]);
    });

    it("names an allowance for a command the tree no longer accepts", () => {
      // A recorded decision cannot outlive the thing it was about.

      const allowed = new Map([["retired", "gone"]]);
      expect(
        reportCommandDocs(declared, new Set(declared), allowed).staleAllowance,
      ).toEqual(["retired"]);
    });
  });

  describe("describeCommandDocFailures()", () => {
    it("returns nothing when the report is empty", () => {
      expect(describeCommandDocFailures({
        undocumented: [],
        staleAllowance: [],
      })).toEqual([]);
    });

    it("names the table to edit and the commands at fault", () => {
      const text = describeCommandDocFailures({
        undocumented: ["brew"],
        staleAllowance: ["retired"],
      }).join("\n");
      expect(text).toContain("NO_PROSE");
      expect(text).toContain("cf brew");
      expect(text).toContain("cf retired");
    });
  });

  describe("main()", () => {
    it("returns 0 for the CLI's own command tree", async () => {
      // The gate itself. Every command the CLI accepts is described in a live
      // document, or recorded as deliberately without prose.

      expect(await main()).toBe(0);
    });

    it("records a reason for every allowance, so none is a bare exemption", () => {
      for (const [command, reason] of NO_PROSE) {
        expect(reason.trim().length, `${command} has no reason`)
          .toBeGreaterThan(0);
      }
    });

    it("fails a command no document names, printing the finding and the remedy", async () => {
      // Against a root holding no documents at all, every command the CLI
      // declares is undocumented — which is the shape of the failure a real
      // one takes, one command at a time.

      const { code, err } = await withFailure();
      expect(code).toBe(1);
      expect(err).toContain("Command documentation check failed.");
      expect(err).toContain("are named in no live document");
      expect(err).toContain("NO_PROSE");
      // The offending commands by name, not a count an operator cannot act
      // on, and the remedy beside them.
      expect(err).toContain("cf cell get");
      expect(err).toContain("cf piece survey");
      expect(err).toContain("Either describe the command in a live document");
      expect(err).toContain("tasks/check-command-docs.ts");
    });

    it("lists the undocumented commands and succeeds when asked for the list", async () => {
      // `--list` is the working view: it answers what is undocumented
      // without failing, so the list can be read while it is worked through.

      let captured = { code: -1, out: "", err: "" };
      await withEmptyRoot(async (root) => {
        captured = await captureConsole(() => main(["--list"], root));
      });
      expect(captured.code).toBe(0);
      expect(captured.out).toContain("cf cell get");
      expect(captured.out).toContain("cf piece survey");
      // The list is the whole of what it prints: no verdict line, because
      // the run passed and the list is not a failure report.
      expect(captured.out).not.toContain("Command documentation OK");
      expect(captured.err).toBe("");
      // A command the allowance covers is decided, so it is not undecided.
      for (const command of NO_PROSE.keys()) {
        expect(captured.out).not.toContain(`cf ${command}`);
      }
    });
  });

  describe("as the task runs it", () => {
    // Calling main() above would still pass if the entry point never ran it,
    // or if the permissions the task declares were too narrow to walk the
    // tree. This is the promise the CI job makes: the command exits 0, having
    // done the work.

    it("exits 0 reporting the commands it walked", async () => {
      const { code, out } = await runAsProgram();
      expect(code).toBe(0);
      expect(out).toContain("Command documentation OK");
      expect(out).toMatch(/\d+ command\(s\)/);
      expect(out).toMatch(/\d+ deliberately without prose/);
    });

    it("exits 0 printing nothing to list when every command is documented", async () => {
      // The gate is green on this repository, so the working view is empty —
      // and an empty list is a result, not a silence to be read as an error.

      const { code, out } = await runAsProgram("--list");
      expect(code).toBe(0);
      expect(out.trim()).toBe("");
    });
  });
});
