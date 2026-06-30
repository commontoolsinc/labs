import { assert, assertEquals, assertMatch, assertThrows } from "@std/assert";
import {
  escapeRegex,
  mirrorOutput,
  parseProfileArgs,
  pickInspectPort,
  profileTimestamp,
  slugifyProfileName,
  stopCaptureOnce,
} from "./cf-profile-lib.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function createSink() {
  const chunks: Uint8Array[] = [];
  return {
    chunks,
    sink: {
      write(data: Uint8Array): number {
        chunks.push(data);
        return data.length;
      },
    },
  };
}

Deno.test("parseProfileArgs separates profiler options from CLI arguments", () => {
  const parsed = parseProfileArgs([
    "--profile-output=profile.cpuprofile",
    "--profile-summary-pattern=done",
    "--profile-start-pattern=start",
    "--profile-stop-pattern=stop",
    "--profile-target-url-pattern=mod.ts",
    "--profile-inspect-port=9333",
    "--profile-timeout-ms=5000",
    "--profile-connect-timeout-ms=2500",
    "test",
    "--filter=unit",
  ]);

  assertEquals(parsed, {
    options: {
      outputPath: "profile.cpuprofile",
      summaryPattern: "done",
      profileStartPattern: "start",
      profileStopPattern: "stop",
      targetUrlPattern: "mod.ts",
      inspectPort: 9333,
      timeoutMs: 5000,
      connectTimeoutMs: 2500,
    },
    cliArgs: ["test", "--filter=unit"],
  });
});

Deno.test("parseProfileArgs accepts an output directory", () => {
  const parsed = parseProfileArgs(["--profile-dir=profiles", "test"]);

  assertEquals(parsed.options.outputDir, "profiles");
  assertEquals(parsed.options.timeoutMs, 120_000);
  assertEquals(parsed.options.connectTimeoutMs, 30_000);
  assertEquals(parsed.cliArgs, ["test"]);
});

Deno.test("parseProfileArgs rejects invalid profiler options", () => {
  const cases: Array<[string[], string]> = [
    [
      ["--profile-output=profile.cpuprofile", "--profile-dir=profiles"],
      "Pass either --profile-output or --profile-dir, not both",
    ],
    [
      ["--profile-inspect-port=0"],
      "--profile-inspect-port must be a positive number",
    ],
    [
      ["--profile-timeout-ms=-1"],
      "--profile-timeout-ms must be a non-negative number",
    ],
    [
      ["--profile-connect-timeout-ms=NaN"],
      "--profile-connect-timeout-ms must be a non-negative number",
    ],
  ];

  for (const [args, message] of cases) {
    assertThrows(() => parseProfileArgs(args), Error, message);
  }
});

Deno.test("slugifyProfileName makes stable output path names", () => {
  assertEquals(
    slugifyProfileName(["test", "--filter=hello world", "a/b"]),
    "test-filter-hello-world-a-b",
  );
  assertEquals(slugifyProfileName(["***"]), "cf");
  assertEquals(slugifyProfileName(["a".repeat(100)]), "a".repeat(80));
});

Deno.test("profileTimestamp uses filename-safe separators", () => {
  assertMatch(profileTimestamp(), /^\d{4}-\d{2}-\d{2}T[\d-]+Z$/);
});

Deno.test("escapeRegex escapes regex syntax", () => {
  assertEquals(
    escapeRegex("a+b*(c)[d]{e}|f?^$\\."),
    "a\\+b\\*\\(c\\)\\[d\\]\\{e\\}\\|f\\?\\^\\$\\\\\\.",
  );
});

Deno.test("pickInspectPort returns a requested port", () => {
  assertEquals(pickInspectPort(9333), 9333);
});

Deno.test("pickInspectPort allocates a TCP port", () => {
  assert(pickInspectPort() > 0);
});

Deno.test("pickInspectPort closes non-TCP listeners before throwing", () => {
  let closed = false;

  assertThrows(
    () =>
      pickInspectPort(undefined, () => ({
        addr: {
          transport: "unix",
          path: "/tmp/profile.sock",
        } as Deno.Addr,
        close: () => {
          closed = true;
        },
      })),
    Error,
    "Expected a TCP listener while allocating inspect port",
  );
  assertEquals(closed, true);
});

Deno.test("stopCaptureOnce sends one signal", () => {
  const state = { sent: false };
  const signals: Deno.Signal[] = [];

  stopCaptureOnce(state, {
    kill: (signal) => {
      signals.push(signal);
    },
  });
  stopCaptureOnce(state, {
    kill: (signal) => {
      signals.push(signal);
    },
  });

  assertEquals(state.sent, true);
  assertEquals(signals, ["SIGINT"]);
});

Deno.test("stopCaptureOnce records a sent signal when kill fails", () => {
  const state = { sent: false };

  stopCaptureOnce(state, {
    kill: () => {
      throw new Error("already exited");
    },
  });

  assertEquals(state.sent, true);
});

Deno.test("mirrorOutput ignores a missing stream", async () => {
  const { chunks, sink } = createSink();

  await mirrorOutput(null, sink);

  assertEquals(chunks, []);
});

Deno.test("mirrorOutput forwards text and flushes decoder state", async () => {
  const { chunks, sink } = createSink();
  const seen: string[] = [];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array());
      controller.enqueue(encoder.encode("hello"));
      controller.enqueue(Uint8Array.of(0xc3));
      controller.close();
    },
  });

  await mirrorOutput(stream, sink, (text) => seen.push(text));

  assertEquals(seen, ["hello", "\uFFFD"]);
  assertEquals(
    decoder.decode(
      chunks.reduce((all, chunk) => {
        const next = new Uint8Array(all.length + chunk.length);
        next.set(all);
        next.set(chunk, all.length);
        return next;
      }, new Uint8Array()),
    ),
    "hello\uFFFD",
  );
});
