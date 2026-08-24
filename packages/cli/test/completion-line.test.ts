import { assert, assertEquals } from "@std/assert";
import {
  resolveCompletionLine,
  stripInvocationPrefix,
} from "../lib/completion/line.ts";
import { tokenizeLine } from "../lib/completion/mod.ts";
import { main } from "../commands/main.ts";

/** Resolve the line the way the shell would, from a raw buffer. */
function resolve(line: string, point = line.length) {
  const { words, cword } = tokenizeLine(line, point);
  return resolveCompletionLine(main, words, cword);
}

Deno.test("tokenizeLine splits on whitespace and marks a trailing empty word", () => {
  assertEquals(tokenizeLine("cf piece ls", 11), {
    words: ["cf", "piece", "ls"],
    cword: 2,
  });
  assertEquals(tokenizeLine("cf piece ", 9), {
    words: ["cf", "piece", ""],
    cword: 2,
  });
});

Deno.test("tokenizeLine keeps quoted and escaped values whole", () => {
  // The whole point of tokenizing in the CLI rather than trusting bash's
  // COMP_WORDS: these must not split.
  assertEquals(tokenizeLine(`cf piece search "meeting notes"`, 31).words, [
    "cf",
    "piece",
    "search",
    "meeting notes",
  ]);
  assertEquals(tokenizeLine(`cf piece ls -s my\\ space`, 24).words, [
    "cf",
    "piece",
    "ls",
    "-s",
    "my space",
  ]);
});

Deno.test("tokenizeLine respects the cursor, ignoring text to its right", () => {
  // Editing mid-line must complete the word under the cursor, not the last.
  const line = "cf piece ls --space team";
  assertEquals(tokenizeLine(line, 8), { words: ["cf", "piece"], cword: 1 });
});

Deno.test("resolve: a bare command offers subcommands", () => {
  const line = resolve("cf ");
  assertEquals(line.slot?.kind, "subcommand");
  assertEquals(line.path, []);
});

Deno.test("resolve: descends into nested subcommands", () => {
  const line = resolve("cf piece call ");
  assertEquals(line.path, ["piece", "call"]);
  assertEquals(line.command.getName(), "call");
});

Deno.test("resolve: an alias descends to the aliased command", () => {
  // `piece rm` is aliased `remove`; both must resolve.
  assertEquals(resolve("cf piece remove ").path, ["piece", "rm"]);
});

Deno.test("resolve: a leaf command's positional is an argument, not a subcommand", () => {
  // Cliffy propagates a global `help` command to every descendant, so
  // `hasCommands()` is true even on leaves. Trusting it would resolve every
  // positional to a subcommand slot and disable all value completion.
  const line = resolve("cf piece call --piece abc ");
  assertEquals(line.slot?.kind, "argument");
  assert(line.slot?.kind === "argument");
  assertEquals(line.slot.argument.name, "callable");
  assertEquals(line.slot.index, 0);
});

Deno.test("resolve: a word starting with - is an option name", () => {
  assertEquals(resolve("cf piece ls --").slot?.kind, "option-name");
  assertEquals(resolve("cf piece ls -").slot?.kind, "option-name");
});

Deno.test("resolve: the word after a value-taking flag is that flag's value", () => {
  const line = resolve("cf piece ls --space ");
  assert(line.slot?.kind === "option-value");
  assertEquals(line.slot.option.name, "space");
});

Deno.test("resolve: a boolean flag does not swallow the following word", () => {
  // `--quiet` takes no value, so the next word is a positional.
  const line = resolve("cf piece get --quiet ");
  assertEquals(line.slot?.kind, "argument");
});

Deno.test("resolve: --name=value completes the value with the prefix retained", () => {
  const line = resolve("cf piece ls --space=");
  assert(line.slot?.kind === "option-value");
  assertEquals(line.slot.option.name, "space");
  assertEquals(line.slot.inlinePrefix, "--space=");
});

Deno.test("resolve: options already typed are captured for provider context", () => {
  const line = resolve(
    "cf piece call -i ./k.key -a http://localhost:8000 -s team --piece fid1:x ",
  );
  assertEquals(line.options.get("identity"), "./k.key");
  assertEquals(line.options.get("api-url"), "http://localhost:8000");
  assertEquals(line.options.get("space"), "team");
  assertEquals(line.options.get("piece"), "fid1:x");
});

Deno.test("resolve: bundled short flags do not shift the argument index", () => {
  // `-qs team` is `-q` plus `-s team`. Mis-parsing it would make the first
  // positional look like the second and select the wrong provider.
  const line = resolve("cf piece get -qs team ");
  assert(line.slot?.kind === "argument");
  assertEquals(line.slot.argument.name, "addressOrPath");
  assertEquals(line.slot.index, 0);
  assertEquals(line.options.get("space"), "team");
  assert(line.flags.has("quiet"));
});

Deno.test("resolve: a second positional advances to the next argument", () => {
  const line = resolve("cf piece link src/field ");
  assert(line.slot?.kind === "argument");
  assertEquals(line.slot.argument.name, "target");
  assertEquals(line.slot.index, 1);
});

Deno.test("resolve: words after -- are passthrough, not CLI options", () => {
  // `cf piece call ... -- --flag` hands `--flag` to the callable's own parser.
  const line = resolve("cf piece call --piece x handler -- --title ");
  assertEquals(line.slot?.kind, "passthrough");
});

Deno.test("resolve: pre-parse globals complete their values", () => {
  // `--log-level` is stripped before Cliffy parses, so it exists nowhere in
  // the command tree and has to be carried explicitly.
  const line = resolve("cf --log-level ");
  assert(line.slot?.kind === "global-option-value");
  assertEquals(line.slot.option.flags, ["--log-level"]);
});

Deno.test("resolve: a pre-parse global does not disturb later resolution", () => {
  const line = resolve("cf --log-level debug piece ");
  assertEquals(line.path, ["piece"]);
  assertEquals(line.slot?.kind, "subcommand");
});

Deno.test("resolve: a stopEarly command offers no option slot past its callable", () => {
  // `piece call` ends option parsing at the callable name, so every later word
  // belongs to the callable's own parser. Offering `--invocation` there names a
  // flag the command refuses.
  const line = resolve("cf piece call --piece x addItem --");
  assert(line.slot?.kind === "argument");
  assertEquals(line.slot.argument.name, "tail");
});

Deno.test("resolve: a flag past that boundary does not shift the positional index", () => {
  // Read as an option, `--title x` would consume two words and put the cursor
  // at the wrong tail position.
  const line = resolve("cf piece call --piece x addItem --title x ");
  assert(line.slot?.kind === "argument");
  assertEquals(line.slot.index, 3);
  assertEquals(line.options.get("piece"), "x");
});

Deno.test("resolve: the boundary does not reach a command that parses to the end", () => {
  // `piece get` is not stopEarly(), so its own flags stay reachable after the
  // path argument.
  const line = resolve("cf piece get --piece x items --");
  assertEquals(line.slot?.kind, "option-name");
});

Deno.test("resolve: `--` after the callable name still opens the passthrough slot", () => {
  const line = resolve("cf piece call --piece x addItem -- --title ");
  assertEquals(line.slot?.kind, "passthrough");
});

Deno.test("resolve: a positional canonical address names the target, not the argument", () => {
  // The command reads the address out before the rest, so the callable is
  // still the argument that follows it.
  const line = resolve("cf piece call -s team /of:fid1:abc ");
  assertEquals(line.address, "/of:fid1:abc");
  assert(line.slot?.kind === "argument");
  assertEquals(line.slot.argument.name, "callable");
});

Deno.test("resolve: an address in `cf get` leaves the path argument next", () => {
  const line = resolve("cf get -s team /of:fid1:abc ");
  assertEquals(line.address, "/of:fid1:abc");
  assert(line.slot?.kind === "argument");
  assertEquals(line.slot.argument.name, "addressOrPath");
  assertEquals(line.slot.index, 0);
});

Deno.test("resolve: a cell path in the same position is not read as an address", () => {
  // A relative cell path never begins with `/`, which is the whole of the
  // grammar that tells the two apart.
  const line = resolve("cf get -s team items ");
  assertEquals(line.address, undefined);
  assertEquals(line.positionals, ["items"]);
});

Deno.test("resolve: a command with no positional address reads the word as its argument", () => {
  // `piece get-label` takes a path and nothing else, so a `/`-leading word is
  // that path rather than a target.
  const line = resolve("cf piece get-label --piece x /of:fid1:abc ");
  assertEquals(line.address, undefined);
  assertEquals(line.positionals, ["/of:fid1:abc"]);
});

Deno.test("stripInvocationPrefix: leaves a plain cf line alone", () => {
  assertEquals(stripInvocationPrefix(["cf", "piece"]), {
    words: ["cf", "piece"],
    removed: 0,
  });
});

Deno.test("stripInvocationPrefix: reduces `deno task cf` to a cf line", () => {
  assertEquals(stripInvocationPrefix(["deno", "task", "cf", "piece"]), {
    words: ["cf", "piece"],
    removed: 2,
  });
});

Deno.test("stripInvocationPrefix: skips deno's own flags", () => {
  assertEquals(
    stripInvocationPrefix(["deno", "-q", "task", "cf", "piece"]).words,
    ["cf", "piece"],
  );
});

Deno.test("stripInvocationPrefix: handles a direct module run", () => {
  assertEquals(
    stripInvocationPrefix(["deno", "run", "-A", "packages/cli/mod.ts", "piece"])
      .words,
    ["cf", "piece"],
  );
});

Deno.test("stripInvocationPrefix: launcher args after -- are cf args", () => {
  assertEquals(
    stripInvocationPrefix([
      "deno",
      "run",
      "-A",
      "packages/cli/launcher.ts",
      "--labs-root",
      "../labs",
      "--",
      "piece",
    ]).words,
    ["cf", "piece"],
  );
});

Deno.test("stripInvocationPrefix: declines non-CLI deno lines", () => {
  // These belong to deno's own completion, not ours.
  for (
    const words of [
      ["deno", "test"],
      ["deno", "task", "build-binaries"],
      ["deno", "run", "-A", "some/other.ts"],
      ["deno"],
    ]
  ) {
    assertEquals(stripInvocationPrefix(words).removed, 0, words.join(" "));
  }
});

Deno.test("resolve: a deno task cf line resolves like a cf line", () => {
  const line = resolve("deno task cf piece call --piece x ");
  assertEquals(line.path, ["piece", "call"]);
  assert(line.slot?.kind === "argument");
  assertEquals(line.slot.argument.name, "callable");
  assertEquals(line.options.get("piece"), "x");
});
