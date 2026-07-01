/**
 * The interactive pager (pager.ts) and mod.ts's interactive branch touch a real
 * terminal, so they are driven here through a pseudo-terminal: the CLI is run
 * under `script`, which gives the child a TTY, and keystrokes are fed to it.
 * Every case quits in-band with `q` (no signals — those do not forward through
 * `script`) and is bounded by a hard timeout so a stuck child never hangs the
 * suite. Skipped where `script` is unavailable.
 */
import { assert } from "@std/assert";
import { join } from "@std/path";

const CLI_MOD = join(import.meta.dirname!, "..", "mod.ts");
const ENC = new TextEncoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function hasScript(): Promise<boolean> {
  if (Deno.build.os !== "linux" && Deno.build.os !== "darwin") return false;
  try {
    const c = new Deno.Command("script", {
      args: Deno.build.os === "linux" ? ["--version"] : ["-h"],
      stdout: "null",
      stderr: "null",
    });
    await c.output();
    return true;
  } catch {
    return false;
  }
}
const SCRIPT = await hasScript();

/** A step of bytes to send, then how long to wait before the next step. */
type Step = { send: string; waitMs?: number };

function spawnUnderPty(args: string[]): Deno.ChildProcess {
  const inner = [Deno.execPath(), "run", "-A", CLI_MOD, ...args];
  const cmd = Deno.build.os === "linux"
    // util-linux: -e returns the child's exit code, -c runs the command.
    ? new Deno.Command("script", {
      args: ["-q", "-e", "-c", inner.join(" "), "/dev/null"],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    })
    // BSD: the command follows the typescript file argument.
    : new Deno.Command("script", {
      args: ["-q", "/dev/null", ...inner],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    });
  return cmd.spawn();
}

async function runInteractive(
  args: string[],
  steps: Step[],
  { startMs = 1800, timeoutMs = 20000 } = {},
): Promise<{ code: number; out: string; timedOut: boolean }> {
  const child = spawnUnderPty(args);
  const writer = child.stdin.getWriter();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGKILL");
    } catch { /* already gone */ }
  }, timeoutMs);

  const feed = (async () => {
    await sleep(startMs); // let deno boot, draw the first frame, enter the read loop
    for (const step of steps) {
      await writer.write(ENC.encode(step.send));
      if (step.waitMs) await sleep(step.waitMs);
    }
    try {
      await writer.close();
    } catch { /* the child may have already exited */ }
  })();

  const { code, stdout } = await child.output();
  clearTimeout(timer);
  await feed.catch(() => {});
  return { code, out: new TextDecoder().decode(stdout), timedOut };
}

const SRC =
  "export const greet = pattern(() => ({ value: 1 }));\nconst other = greet;\n";
const DIFF = `diff --git a/m.ts b/m.ts
index 0000000..1111111 100644
--- a/m.ts
+++ b/m.ts
@@ -1,2 +1,2 @@
-const old = 1;
+const next = 2;
 const ctx = next;
`;

function withDoc(
  text: string,
  fn: (file: string) => Promise<void>,
): () => Promise<void> {
  return async () => {
    const dir = Deno.makeTempDirSync();
    try {
      const file = join(dir, "doc.ts");
      Deno.writeTextFileSync(file, text);
      await fn(file);
    } finally {
      Deno.removeSync(dir, { recursive: true });
    }
  };
}

Deno.test({
  name: "pager: opens a TTY, draws the document, quits on q",
  ignore: !SCRIPT,
  fn: withDoc(SRC, async (file) => {
    const { out, timedOut } = await runInteractive(["view", file], [
      { send: "q" },
    ]);
    assert(!timedOut, "the pager quit before the timeout");
    assert(out.includes("greet"), `drew the document: ${out.slice(0, 120)}`);
  }),
});

Deno.test({
  name: "pager: scrolling and search keystrokes are handled",
  ignore: !SCRIPT,
  fn: withDoc(
    SRC + "x\n".repeat(60),
    async (file) => {
      const { timedOut } = await runInteractive(["view", file], [
        { send: "j", waitMs: 40 },
        { send: "k", waitMs: 40 },
        { send: "G", waitMs: 40 },
        { send: "g", waitMs: 40 },
        { send: "/greet\r", waitMs: 60 },
        { send: "n", waitMs: 40 },
        { send: "?", waitMs: 40 }, // help overlay
        { send: "\x1b", waitMs: 40 }, // escape
        { send: "q" },
      ]);
      assert(!timedOut, "handled the keystrokes and quit");
    },
  ),
});

Deno.test({
  name: "pager: an edit triggers the deferred reparse, then quits",
  ignore: !SCRIPT,
  fn: withDoc(SRC, async (file) => {
    const { timedOut } = await runInteractive(["view", file], [
      { send: "\x1b[B", waitMs: 120 }, // down arrow reveals the text cursor
      { send: "Z", waitMs: 400 }, // type, then pause past the reparse debounce
      { send: "\x1b", waitMs: 120 }, // escape back to navigation
      { send: "q", waitMs: 150 }, // quit — the dirty buffer raises the save prompt
      { send: "d" }, // discard the edit and exit
    ], { timeoutMs: 25000 });
    assert(!timedOut, "reparsed after the pause and quit");
  }),
});

Deno.test({
  name: "pager: a diff is viewed interactively",
  ignore: !SCRIPT,
  fn: withDoc(DIFF, async (file) => {
    const { out, timedOut } = await runInteractive(["view", file], [{
      send: "q",
    }]);
    assert(!timedOut, "the diff pager quit");
    assert(out.includes("next"), `drew the diff: ${out.slice(0, 120)}`);
  }),
});

Deno.test({
  name: "pager: a terminal stdin with no file is reported as no input",
  ignore: !SCRIPT,
  // No file argument and a TTY on stdin: the input reader returns empty rather
  // than blocking on the keyboard, so the viewer reports there is nothing to
  // show and exits.
  fn: async () => {
    const { out, timedOut } = await runInteractive(["view"], [], {
      startMs: 400,
      timeoutMs: 15000,
    });
    assert(!timedOut, "exited without input");
    assert(
      out.toLowerCase().includes("no input"),
      `reported no input: ${out.slice(0, 160)}`,
    );
  },
});
