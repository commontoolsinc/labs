import { assertEquals } from "@std/assert";
import {
  argumentRegion,
  commitFlagRegion,
  commitsAllTracked,
  commitSkipsVerify,
  gitAddInvocations,
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
  // Not a commit at all, so there is no commit whose directory to report: null,
  // meaning "no answer", rather than [] meaning "here, with no redirects".
  // Unreachable through the hook, which gates on isGitCommit first.
  ["grep for the phrase is not a commit", "rg 'git commit' docs/", null],
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
  // The ceiling below is deliberately absurd for a linear parse (microseconds).
  // A tighter one would be a wall-clock invariant on shared CI, which is flaky;
  // this only trips on the 2^N blowup it exists for, which measured 9.6 SECONDS
  // at 26 tokens. Correctness is asserted separately, above and below.
  // An optional value on every option gave N options 2^N readings, and a failed
  // match explored them all: 24 tokens took 1.6s on a hook that runs on every
  // Bash call. This shape is the one that triggered it.
  // Consecutive *bare* flags with no values — the shape that actually
  // backtracks. Built as `--exclude dirN`, this measured nothing: a non-flag
  // value after each option breaks the chain after one iteration.
  const flags = Array.from({ length: 30 }, (_, i) => `--flag${i}`).join(" ");
  const cmd = `ls ~/src/git ${flags} src/ dst/`;
  const start = performance.now();
  assertEquals(isGitCommit(cmd), false);
  const elapsed = performance.now() - start;
  if (elapsed > 3000) {
    throw new Error(
      `took ${elapsed.toFixed(0)}ms; exponential backtracking has returned`,
    );
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

Deno.test("gitAddInvocations resolves each add on its own terms", () => {
  const one = (cmd: string) => gitAddInvocations(cmd)?.[0];

  // A quoted pathspec must survive. Blanking quotes here produced no arguments
  // at all, so the file was never checked and the commit went through.
  assertEquals(one('git add "packages/foo.ts" && git commit -m x')?.paths, [
    "packages/foo.ts",
  ]);
  // A pathspec containing a separator is one word, not two commands.
  assertEquals(one(`git add 'a&b.ts' && git commit -m x`)?.paths, ["a&b.ts"]);

  // The caller's own `--` is a sentinel, not a flag. Classifying by a leading
  // dash re-emitted it ahead of ours and git died on the duplicate, so the file
  // list came back empty and the commit passed in silence.
  assertEquals(one("git add -- bad.ts && git commit -m x"), {
    dirArgs: [],
    flags: [],
    paths: ["bad.ts"],
    dryRunnable: true,
  });
  assertEquals(one("git add -A -- bad.ts && git commit -m x"), {
    dirArgs: [],
    flags: ["-A"],
    paths: ["bad.ts"],
    dryRunnable: true,
  });

  // A redirect is not a pathspec. `>/dev/null` reached git as one, git failed,
  // and the commit passed unchecked.
  assertEquals(one("git add -A >/dev/null && git commit -m x")?.paths, []);
  // The file descriptor is part of the operator: leaving the `2` behind made it
  // a pathspec, git failed on it, and the whole list came back empty.
  assertEquals(one("git add foo.ts 2>/dev/null && git commit -m x")?.paths, [
    "foo.ts",
  ]);
  assertEquals(one("git add foo.ts >>log 2>&1 && git commit -m x")?.paths, [
    "foo.ts",
  ]);

  // Every add, not just the first: bad.ts was staged and never checked.
  assertEquals(
    gitAddInvocations("git add ok.ts && git add bad.ts && git commit -m x")
      ?.flatMap((a) => a.paths),
    ["ok.ts", "bad.ts"],
  );

  // An editing flag writes to the index even under --dry-run, so it must never
  // be run. git accepts unambiguous abbreviations, so every prefix of --edit
  // mutates too — `--e`, `--ed`, `--edi` were all verified to stage. A blacklist
  // of exact words caught none of them, which is why this is a whitelist.
  const dry = (c: string) => one(c)?.dryRunnable;
  for (const f of ["-e", "--edit", "--edi", "--ed", "--e", "-Ae", "-p", "-i"]) {
    assertEquals(dry(`git add ${f} && git commit -m x`), false, f);
  }
  // ...while the flags actually used stay resolvable.
  for (
    const f of ["-A", "-u", "-f", "-Au", "--all", "--update", "--chmod=+x"]
  ) {
    assertEquals(dry(`git add ${f} && git commit -m x`), true, f);
  }

  // The add's directory is where the *add* runs, not where the commit does.
  assertEquals(one("git add foo.ts && cd sub && git commit -m x")?.dirArgs, []);
  assertEquals(
    one("cd sub && git add foo.ts && cd .. && git commit -m x")?.dirArgs,
    ["-C", "sub"],
  );
  assertEquals(one("git -C /a add -A && git -C /a commit -m x")?.dirArgs, [
    "-C",
    "/a",
  ]);

  // No add in the command, and an add named only inside the message.
  assertEquals(gitAddInvocations("git commit -m x"), []);
  assertEquals(gitAddInvocations("git commit -m 'run git add -A'"), []);
});

Deno.test("commitsAllTracked reads flags, not attached values", () => {
  // Real `-a` forms.
  for (const f of ["-a", "-am", "-va", "--all", "-a -m x"]) {
    assertEquals(commitsAllTracked(` ${f} `), true, f);
  }
  // An attached message value is a value, not more flags. `git commit -mdata`
  // read as `-a` swept every tracked change and blocked on unrelated errors.
  for (const f of ["-mdata", "-ma", "-m x", "--amend", "-Fafile", "-m", "-v"]) {
    assertEquals(commitsAllTracked(` ${f} `), false, f);
  }
});

Deno.test("commitSkipsVerify honours both spellings", () => {
  for (const f of ["--no-verify", "-n", "-nm x", "-vn"]) {
    assertEquals(commitSkipsVerify(` ${f} `), true, f);
  }
  // An attached value is a value: `-mn` is a message of "n".
  for (const f of ["-m x", "-mn", "-man", "-a", "--amend", "--no-edit"]) {
    assertEquals(commitSkipsVerify(` ${f} `), false, f);
  }
});

Deno.test("git's -- sentinel ends flag parsing", () => {
  // A file *named* like an option is a pathspec after `--`. Reading it as one
  // turned the hook off (`-n`) or swept the tree (`-a`), leaving it unchecked.
  assertEquals(commitSkipsVerify(" -- -n"), false);
  assertEquals(commitSkipsVerify(" -m x -- -n"), false);
  assertEquals(commitsAllTracked(" -- -a"), false);
  // ...while a real flag before the sentinel still counts.
  assertEquals(commitSkipsVerify(" -n -m x"), true);
  assertEquals(commitsAllTracked(" -am x"), true);
});

Deno.test("commitFlagRegion keeps the command, drops redirections", () => {
  // A commit's flags can sit either side of a redirection — it is all one
  // command — and stopping at one meant blocking a commit git was told to skip.
  assertEquals(
    commitSkipsVerify(commitFlagRegion(" -m x >/dev/null --no-verify")),
    true,
  );
  assertEquals(
    commitSkipsVerify(commitFlagRegion(" -m x 2>err --no-verify")),
    true,
  );
  // ...but a *later command's* flags are not this commit's.
  assertEquals(
    commitsAllTracked(commitFlagRegion(" -m x && git status -a")),
    false,
  );
  assertEquals(
    commitSkipsVerify(commitFlagRegion(" -m x && git commit --no-verify")),
    false,
  );
});

Deno.test("a line continuation is neither a separator nor an argument", () => {
  // `git add \<newline> bad.ts` cut the region at the newline and handed git a
  // lone backslash, so bad.ts was staged, committed and never checked.
  const cmd = "git add \\\n  bad.ts && git commit -m x";
  assertEquals(gitAddInvocations(cmd)?.[0]?.paths, ["bad.ts"]);
});

Deno.test("an unexpanded glob is not resolvable", () => {
  // The shell expands `*.ts` to this directory; git's pathspec matches
  // recursively. Resolving it here blocked commits on files in subdirectories
  // that the command never staged.
  assertEquals(
    gitAddInvocations("git add *.ts && git commit -m x")?.[0]?.dryRunnable,
    false,
  );
  // Brace expansion is the shell's; git has none, so the dry run matched nothing
  // and the files it does stage went unchecked.
  assertEquals(
    gitAddInvocations("git add {a,b}.ts && git commit -m x")?.[0]?.dryRunnable,
    false,
  );
  assertEquals(
    gitAddInvocations("git add ok.ts && git commit -m x")?.[0]?.dryRunnable,
    true,
  );
});

Deno.test("over the option bound, a commit is still recognised", () => {
  // The bounded regex gives up past 12 globals. Giving up there once meant
  // isGitCommit said false and the hook skipped the commit silently; now the
  // linear scan still sees it, and targetDirArgs refuses rather than guessing.
  const many = Array.from({ length: 20 }, (_, i) => `-c k${i}=v${i}`).join(" ");
  const cmd = `git ${many} commit -m x`;
  assertEquals(isGitCommit(cmd), true);
  assertEquals(targetDirArgs(cmd), null);
});

Deno.test("shellWords splits on the mask and unquotes", () => {
  assertEquals(shellWords(`  -A  "a b.ts"  'c&d.ts'  plain.ts `), [
    "-A",
    "a b.ts",
    "c&d.ts",
    "plain.ts",
  ]);
  assertEquals(argumentRegion(" foo.ts && git commit"), " foo.ts ");
  assertEquals(argumentRegion(" foo.ts 2>/dev/null && x"), " foo.ts ");
  assertEquals(argumentRegion(" foo.ts >out"), " foo.ts ");
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
