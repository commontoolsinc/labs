import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import {
  citedPath,
  collectDrift,
  isRooted,
  listTreeFiles,
  readSkillDocs,
  readWorkspaceExports,
  resolvesInTree,
  skillDirOf,
  Tree,
} from "./check-skill-facts.ts";

// A stand-in tree with both citation conventions represented: a repo-root
// scripts/ directory, and a skill that carries its own scripts/ and references/.
const TREE = new Tree([
  "deno.jsonc",
  "docs/development/skill-audit.md",
  "packages/runner/src/cell.ts",
  "scripts/check-local-dev.sh",
  "skills/agent-browser/SKILL.md",
  "skills/agent-browser/scripts/form-automation.sh",
  "skills/lit-component/SKILL.md",
  "skills/lit-component/references/theme-system.md",
  // A symlinked directory: git records it as one file entry, so nothing below it
  // appears in the tree. The real repo has 40-odd of these under .claude/skills
  // and .agents/skills.
  ".claude/skills/lit-component",
]);

Deno.test("Tree knows files, directories, and their ancestors", () => {
  assert(TREE.has("packages/runner/src/cell.ts"));
  assert(TREE.has("packages/runner/src"));
  assert(TREE.has("packages"));
  assert(TREE.isDir("packages/runner"));
  assertEquals(TREE.isDir("packages/runner/src/cell.ts"), false);
  assertEquals(TREE.has("packages/runner/src/nope.ts"), false);
});

Deno.test("Tree.has resolves a path below a symlinked directory", () => {
  // git cannot say what is under .claude/skills/lit-component, so a citation
  // through it must not be reported as missing when it reads fine on disk.
  assert(TREE.has(".claude/skills/lit-component/SKILL.md"));
  assert(TREE.has(".claude/skills/lit-component/references/theme-system.md"));
  // A sibling that is not below any file entry is still judged normally.
  assertEquals(TREE.has(".claude/skills/nonesuch/SKILL.md"), false);
});

Deno.test("Tree.filesMatching selects and sorts", () => {
  assertEquals(TREE.filesMatching(/^skills\/.*\.md$/), [
    "skills/agent-browser/SKILL.md",
    "skills/lit-component/SKILL.md",
    "skills/lit-component/references/theme-system.md",
  ]);
});

Deno.test("citedPath accepts a plain path", () => {
  assertEquals(
    citedPath("packages/runner/src/cell.ts"),
    "packages/runner/src/cell.ts",
  );
});

Deno.test("citedPath strips a leading ./ or /, a #fragment, and trailing slashes", () => {
  assertEquals(
    citedPath("./scripts/check-local-dev.sh"),
    "scripts/check-local-dev.sh",
  );
  // skills/README.md writes the skill mirrors this way.
  assertEquals(citedPath("/.claude/skills/"), ".claude/skills");
  assertEquals(
    citedPath("docs/common/COMPONENTS.md#identity-components"),
    "docs/common/COMPONENTS.md",
  );
  assertEquals(citedPath("docs/history/"), "docs/history");
});

Deno.test("citedPath rejects command lines", () => {
  // Skills backtick whole commands; the path inside one is not the citation.
  assertEquals(citedPath("./scripts/restart-local-dev.sh --force"), null);
  assertEquals(citedPath("deno run -A packages/cli/mod.ts"), null);
  assertEquals(citedPath("cat ~/code/labs/packages/patterns/index.md"), null);
});

Deno.test("citedPath rejects globs and stand-ins", () => {
  assertEquals(citedPath("packages/**"), null);
  assertEquals(citedPath("packages/ui/src/v2/components/cf-*/cf-*.ts"), null);
  assertEquals(
    citedPath("packages/ui/src/v2/components/cf-{name}/cf-{name}.figma.ts"),
    null,
  );
  assertEquals(citedPath("~/.cache/cf-inspect/<host>/"), null);
  assertEquals(citedPath("scripts/..."), null);
  assertEquals(citedPath("path/to/thing.ts"), null);
});

Deno.test("citedPath rejects tokens with no directory separator", () => {
  assertEquals(citedPath("SKILL.md"), null);
  assertEquals(citedPath("waitFor"), null);
});

Deno.test("citedPath rejects a token that is only slashes", () => {
  assertEquals(citedPath("/"), null);
});

Deno.test("isRooted accepts a repo-root directory", () => {
  assert(isRooted("packages/runner/src/cell.ts", "skills/cf-review", TREE));
  assert(isRooted("scripts/check-local-dev.sh", "skills/cf", TREE));
});

Deno.test("isRooted accepts a directory inside the citing skill", () => {
  assert(isRooted("references/theme-system.md", "skills/lit-component", TREE));
});

Deno.test("isRooted rejects prose, flags, specifiers, and mount paths", () => {
  // The conservative half of the heuristic: none of these start with a real
  // directory, so none are treated as repo paths.
  assertEquals(isRooted("async/await", "skills/cf-review", TREE), false);
  assertEquals(isRooted("-s/--space", "skills/cf", TREE), false);
  assertEquals(
    isRooted("lit/directives/class-map.js", "skills/lit-component", TREE),
    false,
  );
  assertEquals(
    isRooted("input/contacts.json", "skills/fuse-workflow", TREE),
    false,
  );
  assertEquals(isRooted("/interface", "skills/cf-review", TREE), false);
  // Ignored build output is not part of the tree, so it never roots a citation.
  assertEquals(isRooted("dist/cf", "skills/cf", TREE), false);
});

Deno.test("resolvesInTree accepts a repo-root-relative citation", () => {
  assert(resolvesInTree("scripts/check-local-dev.sh", "skills/cf", TREE));
});

Deno.test("resolvesInTree accepts a skill-relative citation", () => {
  // skills/agent-browser names scripts/form-automation.sh, which lives in the
  // skill, not in the repo-root scripts/ directory.
  assert(
    resolvesInTree("scripts/form-automation.sh", "skills/agent-browser", TREE),
  );
  assert(
    resolvesInTree("references/theme-system.md", "skills/lit-component", TREE),
  );
});

Deno.test("resolvesInTree rejects a path under neither base", () => {
  assertEquals(
    resolvesInTree("scripts/gone.sh", "skills/agent-browser", TREE),
    false,
  );
});

Deno.test("skillDirOf finds the skill a doc belongs to", () => {
  assertEquals(skillDirOf("skills/cf-review/SKILL.md"), "skills/cf-review");
  assertEquals(
    skillDirOf("skills/lit-component/references/theme-system.md"),
    "skills/lit-component",
  );
  assertEquals(skillDirOf("skills/README.md"), "skills");
});

const EXPORTS = new Map<string, unknown>([
  ["@commonfabric/ui", { ".": "./src/index.ts" }],
  ["@commonfabric/data-model", { "./value-hash": "./value-hash.ts" }],
  ["@commonfabric/runner", "./mod.ts"],
]);

Deno.test("collectDrift is silent on a doc whose citations all resolve", () => {
  const docs = [{
    path: "skills/agent-browser/SKILL.md",
    text: [
      "Run `scripts/form-automation.sh` to drive a form.",
      "The cell lives in `packages/runner/src/cell.ts`.",
      'Import from "@commonfabric/runner" and "@commonfabric/data-model/value-hash".',
    ].join("\n"),
  }];
  assertEquals(collectDrift(docs, TREE, EXPORTS), []);
});

Deno.test("collectDrift reports a vanished path with its line", () => {
  const docs = [{
    path: "skills/cf-review/SKILL.md",
    text: "Line one.\nThe helper is in `packages/runner/src/gone.ts`.\n",
  }];
  assertEquals(collectDrift(docs, TREE, EXPORTS), [{
    file: "skills/cf-review/SKILL.md",
    line: 2,
    message: "path does not exist: packages/runner/src/gone.ts",
  }]);
});

Deno.test("collectDrift reports a subpath specifier a package does not export", () => {
  const docs = [{
    path: "skills/lit-component/SKILL.md",
    text: "Components are exported from `@commonfabric/ui/v2`.\n",
  }];
  const drift = collectDrift(docs, TREE, EXPORTS);
  assertEquals(drift.length, 1);
  assertEquals(drift[0].line, 1);
  assert(drift[0].message.includes('has no export "./v2"'));
});

Deno.test("collectDrift reports a bare specifier for a subpath-only package", () => {
  const docs = [{
    path: "skills/cf-review/SKILL.md",
    text: 'Hashing lives in "@commonfabric/data-model".\n',
  }];
  const drift = collectDrift(docs, TREE, EXPORTS);
  assertEquals(drift.length, 1);
  assert(drift[0].message.includes("has no root export"));
});

Deno.test("collectDrift reports a package that left the workspace", () => {
  const docs = [{
    path: "skills/cf-review/SKILL.md",
    text: 'Import "@commonfabric/nonesuch".\n',
  }];
  const drift = collectDrift(docs, TREE, EXPORTS);
  assertEquals(drift.length, 1);
  assert(drift[0].message.includes("package not in workspace"));
});

Deno.test("collectDrift resolves each doc against its own skill", () => {
  // The same token, cited by two skills, resolves for the one that carries the
  // script and fails for the one that does not.
  const docs = [
    {
      path: "skills/agent-browser/SKILL.md",
      text: "`scripts/form-automation.sh`\n",
    },
    { path: "skills/cf/SKILL.md", text: "`scripts/form-automation.sh`\n" },
  ];
  const drift = collectDrift(docs, TREE, EXPORTS);
  assertEquals(drift.length, 1);
  assertEquals(drift[0].file, "skills/cf/SKILL.md");
});

// Runs against the real repository: every fact every skill cites must resolve.
Deno.test("every skill's cited paths and specifiers resolve", async () => {
  const root = fromFileUrl(new URL("..", import.meta.url));
  const tree = new Tree(await listTreeFiles(root));
  const docs = await readSkillDocs(root, tree);
  assert(docs.length > 0, "found no markdown under skills/");
  const drift = collectDrift(docs, tree, await readWorkspaceExports(root));
  assertEquals(
    drift.map((d) => `${d.file}:${d.line} ${d.message}`),
    [],
    "A skill cites a path or specifier that no longer resolves. Skills are live " +
      "documentation: fix the skill to name the current location.",
  );
});
