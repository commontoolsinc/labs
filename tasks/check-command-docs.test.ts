import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Command } from "@cliffy/command";
import {
  declaredCommands,
  describeCommandDocFailures,
  documentedCommands,
  isLiveDoc,
  main,
  NO_PROSE,
  reportCommandDocs,
} from "./check-command-docs.ts";

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
  });

  describe("isLiveDoc()", () => {
    it("reads a path spelled with either separator", () => {
      // The rules are written in slashes and the path arrives in the host's
      // separator, so a Windows spelling has to reach the same verdict.
      expect(isLiveDoc("docs/guide.md")).toBe(true);
      expect(isLiveDoc("docs\\guide.md")).toBe(true);
      expect(isLiveDoc("docs/history/report.md")).toBe(false);
      expect(isLiveDoc("docs\\history\\report.md")).toBe(false);
      expect(isLiveDoc("docs\\plans\\later.md")).toBe(false);
      expect(isLiveDoc("packages\\oven\\brew.ts")).toBe(false);
      expect(isLiveDoc("packages\\oven\\docs\\guide.md")).toBe(false);
      expect(isLiveDoc("packages\\oven\\README.md")).toBe(true);
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
  });
});
