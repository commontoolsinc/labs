import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  complete,
  staticCandidates,
  tokenizeLine,
} from "../lib/completion/mod.ts";
import { resolveCompletionLine } from "../lib/completion/line.ts";
import {
  bashCompletionScript,
  zshCompletionScript,
} from "../lib/completion/script.ts";
import { main } from "../commands/main.ts";

function staticFor(line: string): string[] {
  const { words, cword } = tokenizeLine(line, line.length);
  return staticCandidates(resolveCompletionLine(main, words, cword))
    .map((candidate) => candidate.value);
}

/**
 * Drive the full pipeline. Safe without a fabric: every line here resolves to
 * a slot with no live provider, or to one whose context cannot be resolved,
 * and providers degrade to empty rather than reaching the network.
 */
async function completeFor(line: string, shell: "bash" | "zsh" = "bash") {
  const { words, cword } = tokenizeLine(line, line.length);
  return await complete(main, words, cword, shell);
}

Deno.test("top-level completion lists real commands", () => {
  const values = staticFor("cf ");
  for (const expected of ["piece", "check", "inspect", "id", "completion"]) {
    assert(values.includes(expected), `missing ${expected}`);
  }
});

Deno.test("internal plumbing commands are not offered", () => {
  // `fuse-daemon`/`fuse-supervisor` are spawned by `cf fuse`, never typed.
  const values = staticFor("cf ");
  assertFalse(values.includes("fuse-daemon"));
  assertFalse(values.includes("fuse-supervisor"));
});

Deno.test("Cliffy's generated help subcommand is not offered", () => {
  assertFalse(staticFor("cf ").includes("help"));
  assertFalse(staticFor("cf piece ").includes("help"));
});

Deno.test("option names include inherited globals", () => {
  const values = staticFor("cf piece ls --");
  for (const expected of ["--space", "--identity", "--api-url", "--json"]) {
    assert(values.includes(expected), `missing ${expected}`);
  }
});

Deno.test("a single dash offers short flags, a double dash does not", () => {
  assert(staticFor("cf piece ls -").includes("-s"));
  assertFalse(staticFor("cf piece ls --").includes("-s"));
});

Deno.test("pre-parse globals are offered even though they are not in the tree", () => {
  const values = staticFor("cf piece ls --");
  assert(values.includes("--log-level"));
  assert(values.includes("--no-color"));
});

Deno.test("an option already supplied is not offered again", () => {
  const values = staticFor("cf piece ls --space team --");
  assertFalse(values.includes("--space"));
  assert(values.includes("--identity"));
});

Deno.test("--log-level completes its accepted levels", async () => {
  assertEquals(await completeFor("cf --log-level "), [
    "debug",
    "info",
    "warn",
    "error",
    "silent",
  ]);
});

Deno.test("--log-level=<value> keeps the inline prefix on candidates", async () => {
  // The shell replaces the whole token, so a bare `debug` would produce
  // `cf --log-level=debug` -> `cf debug`.
  assertEquals(await completeFor("cf --log-level=de"), ["--log-level=debug"]);
});

Deno.test("candidates are filtered by the typed prefix", async () => {
  const values = await completeFor("cf piece se");
  assert(values.length > 0);
  for (const value of values) {
    assert(value.startsWith("se"), `${value} does not match prefix`);
  }
});

Deno.test("zsh output pairs a candidate with its description", async () => {
  const values = await completeFor("cf ", "zsh");
  const piece = values.find((value) => value.startsWith("piece:"));
  assert(piece, "expected a described `piece` candidate");
});

Deno.test("zsh output escapes colons inside values", async () => {
  // `_describe` splits on the first unescaped colon; an api-url has two, and
  // an unescaped one truncates the inserted value.
  const values = await completeFor("cf piece ls -a ", "zsh");
  const local = values.find((value) => value.includes("localhost"));
  assert(local, "expected a localhost api-url candidate");
  assert(
    local.startsWith("http\\://"),
    `colons must be escaped, got ${local}`,
  );
});

Deno.test("bash output carries values only", async () => {
  const values = await completeFor("cf ", "bash");
  for (const value of values) {
    assertFalse(value.includes(":"), `bash candidates carry no description`);
  }
});

Deno.test("pattern-file arguments defer to the shell's file completion", async () => {
  // The shell handles quoting, `~`, and directories far better than we can.
  assertEquals(await completeFor("cf check "), [":cf:files *.tsx"]);
  assertEquals(await completeFor("cf piece new "), [":cf:files *.tsx"]);
});

Deno.test("--identity defers to file completion filtered to keyfiles", async () => {
  assertEquals(await completeFor("cf piece ls -i "), [":cf:files *.key"]);
});

Deno.test("--root defers to directory completion", async () => {
  assertEquals(await completeFor("cf piece new --root "), [":cf:dirs"]);
});

Deno.test("a live slot with no resolvable context yields nothing, not an error", async () => {
  // Mid-keystroke with no identity configured: silence is the correct signal.
  const previous = Deno.env.get("CF_IDENTITY");
  Deno.env.delete("CF_IDENTITY");
  try {
    assertEquals(await completeFor("cf piece call --piece "), []);
  } finally {
    if (previous !== undefined) Deno.env.set("CF_IDENTITY", previous);
  }
});

Deno.test("a non-CLI deno line hands back to deno's own completion", async () => {
  assertEquals(await completeFor("deno test "), [":cf:notmine"]);
  assertEquals(await completeFor("deno task build-binaries "), [":cf:notmine"]);
});

Deno.test("a deno task cf line completes as cf", async () => {
  const values = await completeFor("deno task cf piece l");
  assertEquals(values, ["ls", "link"]);
});

Deno.test("generated scripts bind both the CLI name and deno", () => {
  const bash = bashCompletionScript("cf");
  assert(bash.includes("complete -F _cf_complete cf"));
  assert(bash.includes("complete -F _cf_complete deno"));

  const zsh = zshCompletionScript("cf");
  assert(zsh.includes("compdef _cf deno"));
});

Deno.test("--no-deno-task omits the deno binding", () => {
  const bash = bashCompletionScript("cf", { denoTask: false });
  assert(bash.includes("complete -F _cf_complete cf"));
  assertFalse(bash.includes("complete -F _cf_complete deno"));
  assertFalse(bash.includes("complete -p deno"));

  const zsh = zshCompletionScript("cf", { denoTask: false });
  assert(zsh.includes("compdef _cf cf"));
  assertFalse(zsh.includes("compdef _cf deno"));
});

Deno.test("generated scripts refuse to chain to themselves", () => {
  // Sourcing twice (profile plus bash_completion.d, or a re-sourced profile)
  // makes the second pass observe the binding the first installed. Capturing
  // it recurses forever on the next non-CLI `deno` completion and hangs the
  // terminal; this guard is the only thing preventing that.
  const bash = bashCompletionScript("cf");
  assert(bash.includes(`!= "_cf_complete"`), "bash must reject a self-capture");

  const zsh = zshCompletionScript("cf");
  assert(zsh.includes(`!= "_cf"`), "zsh must reject a self-capture");
});

Deno.test("generated scripts keep an already-captured deno completion", () => {
  // The guard must not clear a good value recorded by an earlier source, or a
  // re-source silently drops deno's real completion.
  const bash = bashCompletionScript("cf");
  assert(bash.includes('_cf_deno_previous="${_cf_deno_previous:-}"'));

  const zsh = zshCompletionScript("cf");
  assert(zsh.includes('_cf_deno_previous="${_cf_deno_previous:-}"'));
});

Deno.test("generated scripts capture the previous deno completion before rebinding", () => {
  // Order matters: reading the old spec after `complete -F` would capture
  // our own function and recurse.
  const bash = bashCompletionScript("cf");
  assert(
    bash.indexOf("complete -p deno") <
      bash.indexOf("complete -F _cf_complete deno"),
  );
  const zsh = zshCompletionScript("cf");
  assert(zsh.indexOf("_comps[deno]") < zsh.indexOf("compdef _cf deno"));
});

Deno.test("generated bash script avoids bash 4 builtins", () => {
  // macOS ships bash 3.2: `mapfile` does not exist at all, and `compopt` is
  // absent so it must be probed before use. Match on invocations rather than
  // on the words appearing in explanatory comments.
  const bash = bashCompletionScript("cf");
  const code = bash.split("\n").filter((line) => !line.trim().startsWith("#"));
  assertFalse(
    code.some((line) => /(^|[;&|( ])mapfile\b/.test(line)),
    "mapfile is bash 4+",
  );

  const guard = bash.indexOf("type compopt >/dev/null 2>&1");
  assert(guard !== -1, "compopt must be probed before use");
  assert(
    guard < bash.indexOf("compopt -o nospace"),
    "the compopt probe must precede the call",
  );
});

Deno.test("the CLI name flows into the generated function names", () => {
  const script = bashCompletionScript("mycf");
  assert(script.includes("_mycf_complete()"));
  assert(script.includes("complete -F _mycf_complete mycf"));
});
