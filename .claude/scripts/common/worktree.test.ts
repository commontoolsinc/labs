import { assertEquals } from "@std/assert";
import {
  argumentRegion,
  gitAddInvocation,
  isGitCommit,
  shellWords,
  splitAtGitSubcommand,
  targetDirArgs,
  withoutQuotedSpans,
} from "./worktree.ts";

/**
 * The command parser decides which worktree a commit is judged against, from a
 * string the agent wrote. Every entry below is a shape that once produced a
 * wrong answer: the wrong tree, a silent bypass, or a block on files nobody was
 * committing. A table is the honest form for this — each row is one sentence
 * about shell syntax, and the bugs it guards against were all one row each.
 *
 * `null` means "cannot determine, skip and do not block". Preferring it to a
 * guess is the design: a wrong tree blocks correct work, and `--no-verify` is
 * the only way past.
 */
const TARGET_DIR_CASES: Array<
  [name: string, cmd: string, want: string[] | null]
> = [
  // --- the plain forms ---
  ["bare commit", "git commit -m x", []],
  ["cd then commit", "cd /a && git commit -m x", ["-C", "/a"]],
  ["git -C", "git -C /a commit -m x", ["-C", "/a"]],
  ["cd and -C compose", "cd /a && git -C /b commit -m x", [
    "-C",
    "/a",
    "-C",
    "/b",
  ]],
  // Every cd is passed on, in order. git composes them exactly as a shell
  // does — verified: a later absolute `-C` overrides, a relative one appends —
  // so /b wins here without us having to decide that ourselves.
  ["successive absolute cds", "cd /a; cd /b; git commit -m x", [
    "-C",
    "/a",
    "-C",
    "/b",
  ]],
  ["relative cd", "cd packages/runner && git commit -m x", [
    "-C",
    "packages/runner",
  ]],
  ["add -A before commit", "cd /a && git add -A && git commit -m x", [
    "-C",
    "/a",
  ]],

  // --- quoting ---
  ["single-quoted cd", "cd '/a b' && git commit -m x", ["-C", "/a b"]],
  ["double-quoted cd", 'cd "/a b" && git commit -m x', ["-C", "/a b"]],
  ["quoted -C", 'git -C "/a b" commit -m x', ["-C", "/a b"]],
  ["quoted -c value", 'git -c user.name="A B" commit -m x', []],

  // --- the commit message is free text, never a command ---
  ["cd in message", "git commit -m 'cd /evil && rm -rf /'", []],
  ["work-tree in message", "git commit -m 'explain --work-tree'", []],
  ["git-dir in message", 'git commit -m "fix --git-dir= handling"', []],
  ["add in message", "git commit -m 'run git add -A first'", []],

  // --- explicit overrides we do not model ---
  ["--work-tree", "git --work-tree=/a commit -m x", null],
  ["--git-dir", "git --git-dir=/a/.git commit -m x", null],

  // --- multi-line scripts, the common agent shape ---
  ["cd on its own line", "cd /a\ngit commit -m x", ["-C", "/a"]],
  ["cd on a later line", "git status\ncd /a\ngit commit -m x", ["-C", "/a"]],
  [
    "heredoc body is data",
    "cat > f <<'EOF'\ncd /evil\nEOF\ngit commit -m x",
    null,
  ],
  [
    "heredoc after commit is fine",
    "cd /a && git commit -F - <<'EOF'\nmsg\nEOF",
    [
      "-C",
      "/a",
    ],
  ],

  // --- subshells: a cd inside one does not outlive it, and telling whether
  // --- the commit shares it is parsing. Refuse rather than guess.
  ["subshell around both", "(cd /a && git commit -m x)", null],
  [
    "subshell around only the add",
    "(cd /a && git add -A) && git commit -m x",
    null,
  ],
  [
    "command substitution",
    "X=$(cd /a && git rev-parse HEAD) && git commit -m x",
    null,
  ],
  [
    "subshell after a real cd",
    "cd /a && (cd /b && ls) && git commit -m x",
    null,
  ],

  // --- brace groups run in the current shell, so their cd holds ---
  ["brace group", "{ cd /a; git commit -m x; }", ["-C", "/a"]],

  // --- quoted text is data: it may not create, move, or become a match ---
  [
    "quoted -C in an echo",
    'echo "git -C /other commit" && git commit -m x',
    [],
  ],
  [
    "quoted mention before a real cd",
    'echo "git commit" && cd /a && git commit -m x',
    [
      "-C",
      "/a",
    ],
  ],
  ["grep for the phrase is not a commit", "rg 'git commit' docs/", []],
  // An escaped quote must not end the span early: the tail would be unmasked,
  // and text carrying its own separator was read as commands again.
  [
    "escaped quote smuggling a cd",
    String.raw`echo "a \" && cd /evil && echo \"" && git commit -m x`,
    [],
  ],
  [
    "escaped quote smuggling a ;cd",
    String.raw`echo "x\" ; cd /evil ; echo \"" && git commit -m x`,
    [],
  ],
  // ...while an escape before a genuine cd leaves that cd intact.
  [
    "escape then a real cd",
    String.raw`printf "%s" "x\"" && cd /real && git commit -m x`,
    ["-C", "/real"],
  ],
  // An apostrophe in prose must not pair with a later one and blank a real cd.
  [
    "apostrophe in a double-quoted string",
    `echo "it's fine" && cd /a && echo "don't" && git commit -m x`,
    ["-C", "/a"],
  ],

  // --- cds compose; the last one alone was resolved against the wrong base ---
  ["absolute then relative", "cd /a && cd sub && git commit -m x", [
    "-C",
    "/a",
    "-C",
    "sub",
  ]],
  ["pushd moves the shell too", "pushd /a && git commit -m x", ["-C", "/a"]],
  ["popd is unmodellable", "pushd /a && popd && git commit -m x", null],
];

Deno.test("targetDirArgs resolves the directory a commit lands in", () => {
  for (const [name, cmd, want] of TARGET_DIR_CASES) {
    assertEquals(targetDirArgs(cmd), want, `${name}: ${JSON.stringify(cmd)}`);
  }
});

/**
 * A commit that is not recognised is a commit that is never checked, so the
 * detector has to see every way git can be steered to `commit`.
 */
const IS_COMMIT_CASES: Array<[cmd: string, want: boolean]> = [
  ["git commit -m x", true],
  ["git -C /a commit -m x", true],
  ['git -C "/a b" commit -m x', true],
  ['git -c user.name="A B" commit -m x', true],
  ["git --no-pager commit -m x", true],
  ["git -C /a -c core.hooksPath=/dev/null commit -m x", true],
  ["git status", false],
  ["git add -A", false],
  ["echo commit", false],
  // Quoted: data, not an invocation. Blocking `rg` on staged-file errors is a
  // failure of the same kind as blocking a commit on another branch's.
  ["rg 'git commit' docs/", false],
  ['echo "remember to git commit -m wip"', false],
];

Deno.test("isGitCommit does not backtrack exponentially", () => {
  // An optional value on every option gave N options 2^N readings, and a failed
  // match explored them all: 24 tokens took 1.6s on a hook that runs on every
  // Bash call. This shape is the one that triggered it.
  const flags = Array.from({ length: 30 }, (_, i) => `--exclude dir${i}`).join(
    " ",
  );
  const cmd = `rsync -av ${flags} src/ dst/`;
  const start = performance.now();
  assertEquals(isGitCommit(cmd), false);
  const elapsed = performance.now() - start;
  if (elapsed > 250) {
    throw new Error(`took ${elapsed.toFixed(0)}ms; expected well under 250ms`);
  }
});

Deno.test("isGitCommit sees every steering form", () => {
  for (const [cmd, want] of IS_COMMIT_CASES) {
    assertEquals(isGitCommit(cmd), want, cmd);
  }
});

Deno.test("withoutQuotedSpans hides message text from flag scans", () => {
  // The bug this exists for: a message mentioning -a swept the whole dirty tree.
  const flagRe = /(?:^|\s)(?:--all(?:\s|$)|-[a-zA-Z]*a[a-zA-Z]*(?:\s|$))/;
  assertEquals(
    flagRe.test(withoutQuotedSpans(' -m "honour the -a flag"')),
    false,
  );
  assertEquals(
    flagRe.test(withoutQuotedSpans(" -m 'use -am for speed'")),
    false,
  );
  // ...while a real flag, before or after the message, still registers.
  assertEquals(flagRe.test(withoutQuotedSpans(' -am "msg"')), true);
  assertEquals(flagRe.test(withoutQuotedSpans(' -m "msg" -a')), true);
  // And --no-verify in prose must not disable the hook.
  const noVerify = /(?:^|\s)--no-verify(?:\s|$)/;
  assertEquals(
    noVerify.test(withoutQuotedSpans(' -m "docs: --no-verify escape"')),
    false,
  );
  assertEquals(noVerify.test(withoutQuotedSpans(" --no-verify -m x")), true);
  // Escapes are handled here too, from sharing the mask: ending the span at the
  // first `"` left the tail visible, and a flag in that tail counted.
  assertEquals(
    flagRe.test(withoutQuotedSpans(String.raw` -m "a \" -a \""`)),
    false,
  );
  assertEquals(
    noVerify.test(withoutQuotedSpans(String.raw` -m "a \" --no-verify \""`)),
    false,
  );
});

Deno.test("gitAddInvocation resolves the add on its own terms", () => {
  // A quoted pathspec must survive. Blanking quotes here produced no arguments
  // at all, so the file was never checked and the commit went through.
  assertEquals(
    gitAddInvocation('git add "packages/foo.ts" && git commit -m x')?.words,
    ["packages/foo.ts"],
  );
  // A pathspec containing a separator is one word, not two commands.
  assertEquals(
    gitAddInvocation(`git add 'a&b.ts' && git commit -m x`)?.words,
    ["a&b.ts"],
  );
  // The add's directory is where the *add* runs, not where the commit does.
  assertEquals(
    gitAddInvocation("git add foo.ts && cd sub && git commit -m x")?.dirArgs,
    [],
  );
  assertEquals(
    gitAddInvocation("cd sub && git add foo.ts && cd .. && git commit -m x")
      ?.dirArgs,
    ["-C", "sub"],
  );
  // And its own `-C` still counts.
  assertEquals(
    gitAddInvocation("git -C /a add -A && git -C /a commit -m x")?.dirArgs,
    ["-C", "/a"],
  );
  // No add in the command at all.
  assertEquals(gitAddInvocation("git commit -m x"), null);
  // A `git add` named only inside the message is not an add.
  assertEquals(gitAddInvocation("git commit -m 'run git add -A'"), null);
});

Deno.test("shellWords splits on the mask and unquotes", () => {
  assertEquals(shellWords(`  -A  "a b.ts"  'c&d.ts'  plain.ts `), [
    "-A",
    "a b.ts",
    "c&d.ts",
    "plain.ts",
  ]);
  assertEquals(argumentRegion(" foo.ts && git commit"), " foo.ts ");
  assertEquals(argumentRegion(` 'a&b.ts' && git commit`), ` 'a&b.ts' `);
});

Deno.test("splitAtGitSubcommand keeps each pattern in its own region", () => {
  const { before, options, after } = splitAtGitSubcommand(
    "cd /a && git -C /b commit -m 'git add -A'",
    "commit",
  );
  assertEquals(before, "cd /a && ");
  assertEquals(options, "-C /b ");
  assertEquals(after, " -m 'git add -A'");

  // A `git add` is found in `before` even when git is steered with globals.
  assertEquals(
    splitAtGitSubcommand("git -C /b add -A && ", "add").after,
    " -A && ",
  );
  // No match leaves the whole string as `before`, so callers scan nothing new.
  assertEquals(splitAtGitSubcommand("git status", "commit"), {
    matched: false,
    before: "git status",
    options: "",
    after: "",
  });
});
