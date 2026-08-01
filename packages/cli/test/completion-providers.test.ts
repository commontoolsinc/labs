import { assert, assertEquals } from "@std/assert";
import { resolveCompletionLine } from "../lib/completion/line.ts";
import {
  keysOf,
  linkEndpointPrefix,
  liveCandidates,
  resolveSpaceContext,
  shapePieceCandidates,
  shapeVerbCandidates,
  splitPathPrefix,
} from "../lib/completion/providers.ts";
import { tokenizeLine } from "../lib/completion/mod.ts";
import { main } from "../commands/main.ts";

function lineFor(text: string) {
  const { words, cword } = tokenizeLine(text, text.length);
  return resolveCompletionLine(main, words, cword);
}

/**
 * Run `body` with the fabric environment variables set exactly as given,
 * restoring whatever the surrounding process had. Completion reads these as
 * fallbacks, so a test that did not control them would pass or fail based on
 * the developer's shell.
 */
async function withEnv(
  env: { identity?: string; apiUrl?: string },
  body: () => void | Promise<void>,
): Promise<void> {
  const keys = ["CF_IDENTITY", "CF_API_URL"] as const;
  const saved = keys.map((key) => [key, Deno.env.get(key)] as const);
  try {
    Deno.env.delete("CF_IDENTITY");
    Deno.env.delete("CF_API_URL");
    if (env.identity) Deno.env.set("CF_IDENTITY", env.identity);
    if (env.apiUrl) Deno.env.set("CF_API_URL", env.apiUrl);
    await body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

/** Capture stdout writes made by a command action. */
async function captureStdout(body: () => Promise<void>): Promise<string> {
  const original = console.log;
  const chunks: string[] = [];
  console.log = (...args: unknown[]) => void chunks.push(args.join(" "));
  try {
    await body();
  } finally {
    console.log = original;
  }
  return chunks.join("\n");
}

Deno.test("space context: line options beat the environment", async () => {
  // This is what makes `-s other-space --piece <TAB>` list the other space
  // rather than whatever the shell's environment points at.
  await withEnv({ identity: "/env.key", apiUrl: "http://env:9999" }, () => {
    const config = resolveSpaceContext(
      lineFor("cf piece ls -i /line.key -a http://line:8000 -s team "),
    );
    assert(config);
    assertEquals(config.apiUrl, "http://line:8000");
    assertEquals(config.space, "team");
    assertEquals(config.identity, "/line.key");
  });
});

Deno.test("space context: falls back to the environment", async () => {
  await withEnv({ identity: "/env.key", apiUrl: "http://env:9999" }, () => {
    const config = resolveSpaceContext(lineFor("cf piece ls -s team "));
    assert(config);
    assertEquals(config.apiUrl, "http://env:9999");
    assertEquals(config.identity, "/env.key");
  });
});

Deno.test("space context: --url supplies api-url and space together", async () => {
  await withEnv({ identity: "/env.key" }, () => {
    const config = resolveSpaceContext(
      lineFor("cf piece ls -u http://host:8000/myspace/fid1:abc "),
    );
    assert(config);
    assertEquals(config.apiUrl, "http://host:8000");
    assertEquals(config.space, "myspace");
  });
});

Deno.test("space context: reserves stdout for candidates", async () => {
  // `jsonOutput` routes runtime status lines to stderr. Without it a stray
  // console.log from the runtime would be offered to the user as a candidate.
  await withEnv({ identity: "/env.key", apiUrl: "http://env:9999" }, () => {
    assertEquals(
      resolveSpaceContext(lineFor("cf piece ls -s t "))?.jsonOutput,
      true,
    );
  });
});

Deno.test("space context: an incomplete line resolves to nothing", async () => {
  await withEnv({}, () => {
    // No identity anywhere.
    assertEquals(resolveSpaceContext(lineFor("cf piece ls -s team ")), null);
  });
  await withEnv({ identity: "/env.key" }, () => {
    // Identity but no space.
    assertEquals(
      resolveSpaceContext(lineFor("cf piece ls -a http://h:1 ")),
      null,
    );
    // Identity but no api-url.
    assertEquals(resolveSpaceContext(lineFor("cf piece ls -s team ")), null);
  });
});

Deno.test("space context: a malformed --url resolves to nothing, not a throw", async () => {
  await withEnv({ identity: "/env.key" }, () => {
    assertEquals(
      resolveSpaceContext(lineFor("cf piece ls -u not-a-url ")),
      null,
    );
  });
});

Deno.test("live candidates: unmapped slots ask for nothing", async () => {
  // A subcommand or option-name slot is answered statically; reaching for live
  // data there would spend a fabric round trip per keystroke for no reason.
  for (const text of ["cf ", "cf piece ls --", "cf piece "]) {
    const result = await liveCandidates(lineFor(text));
    assertEquals(result.candidates.length, 0, text);
    assertEquals(result.directives.length, 0, text);
  }
});

Deno.test("live candidates: path-shaped slots defer to the shell", async () => {
  const cases: Array<[string, string]> = [
    ["cf piece ls -i ", "files"],
    ["cf piece new --root ", "dirs"],
    ["cf check ", "files"],
    ["cf space verify ", "dirs"],
    ["cf space clone --to ", "dirs"],
    ["cf id did ", "files"],
  ];
  for (const [text, kind] of cases) {
    const result = await liveCandidates(lineFor(text));
    assertEquals(result.directives[0]?.kind, kind, text);
  }
});

Deno.test("live candidates: a fabric slot without context degrades to empty", async () => {
  // Mid-keystroke with nothing configured: silence, not an error.
  await withEnv({}, async () => {
    for (
      const text of [
        "cf piece call --piece x ",
        "cf piece get --piece x ",
        "cf piece link ",
        "cf piece ls --piece ",
      ]
    ) {
      const result = await liveCandidates(lineFor(text));
      assertEquals(result.candidates.length, 0, text);
    }
  });
});

Deno.test("command: bash and zsh subcommands emit their scripts", async () => {
  const bash = await captureStdout(async () => {
    await main.parse(["completion", "bash"]);
  });
  assert(bash.includes("complete -F _cf_complete cf"));

  const zsh = await captureStdout(async () => {
    await main.parse(["completion", "zsh"]);
  });
  assert(zsh.includes("#compdef cf"));
});

Deno.test("command: --no-deno-task reaches the script generator", async () => {
  const bash = await captureStdout(async () => {
    await main.parse(["completion", "bash", "--no-deno-task"]);
  });
  assert(bash.includes("complete -F _cf_complete cf"));
  assert(!bash.includes("complete -F _cf_complete deno"));
});

Deno.test("command: complete accepts bash's raw line form", async () => {
  const out = await captureStdout(async () => {
    await main.parse([
      "completion",
      "complete",
      "--shell",
      "bash",
      "--line",
      "cf piece l",
      "--point",
      "10",
    ]);
  });
  assertEquals(out.split("\n").sort(), ["link", "ls"]);
});

Deno.test("command: complete accepts zsh's pre-tokenized form", async () => {
  const out = await captureStdout(async () => {
    await main.parse([
      "completion",
      "complete",
      "--shell",
      "zsh",
      "--cword",
      "2",
      "--",
      "cf",
      "piece",
      "l",
    ]);
  });
  // zsh output pairs each value with its description.
  const values = out.split("\n").map((line) => line.split(":")[0]).sort();
  assertEquals(values, ["link", "ls"]);
});

Deno.test("command: complete prints nothing when there is nothing to offer", async () => {
  const out = await captureStdout(async () => {
    await main.parse([
      "completion",
      "complete",
      "--shell",
      "bash",
      "--line",
      "cf piece zzzznomatch",
      "--point",
      "23",
    ]);
  });
  assertEquals(out, "");
});

Deno.test("command: malformed input never puts usage text on stdout", async () => {
  // Regression guard. stdout here is a data channel the shell reads on every
  // keystroke; Cliffy answers a malformed invocation by printing usage to
  // stdout, which the shell would then offer as candidates ("Usage:",
  // "-h, --help", ...). Raw-arg parsing is what prevents that.
  const malformed = [
    ["complete"], // no arguments at all
    ["complete", "--shell"], // flag with no value
    ["complete", "--line"], // the case Cliffy rejected outright
    ["complete", "--shell", "bash", "--line", "", "--point", "0"],
    ["complete", "--shell", "bash", "--line", "cf", "--point", "999"],
    ["complete", "--shell", "bash", "--point", "notanumber", "--line", "cf p"],
    ["complete", "--cword", "-4", "--", "cf", "piece"],
    ["complete", "--nonsense-flag", "value"],
  ];

  for (const args of malformed) {
    const out = await captureStdout(async () => {
      await main.parse(["completion", ...args]);
    });
    for (const line of out.split("\n").filter(Boolean)) {
      assert(
        !/^(Usage|Version|Description|Options|Commands):/.test(line) &&
          !line.includes("Show this help"),
        `usage text reached stdout for [${args.join(" ")}]: ${line}`,
      );
    }
  }
});

Deno.test("command: a deno line that is not ours is reported as such", async () => {
  const out = await captureStdout(async () => {
    await main.parse([
      "completion",
      "complete",
      "--shell",
      "bash",
      "--line",
      "deno test ",
      "--point",
      "10",
    ]);
  });
  assertEquals(out, ":cf:notmine");
});

Deno.test("shaping: a piece is labelled by name, falling back to its pattern", () => {
  assertEquals(
    shapePieceCandidates([
      { id: "fid1:a", name: "Todo List" },
      { id: "fid1:b", patternRef: { symbol: "Bookmarks" } },
      { id: "fid1:c" },
      // A piece that failed to load still lists: its id is what an operator
      // reaches for completion to recover.
      { id: "fid1:d", patternRef: null },
    ]),
    [
      { value: "fid1:a", description: "Todo List" },
      { value: "fid1:b", description: "Bookmarks" },
      { value: "fid1:c", description: undefined },
      { value: "fid1:d", description: undefined },
    ],
  );
});

Deno.test("shaping: callables are annotated by kind", () => {
  assertEquals(
    shapeVerbCandidates([
      { name: "addItem", kind: "handler" },
      { name: "search", kind: "tool" },
    ]),
    [
      { value: "addItem", description: "handler" },
      { value: "search", description: "tool" },
    ],
  );
});

Deno.test("shaping: containers yield keys, leaves yield nothing", () => {
  // A leaf yielding nothing is the correct signal that the path already names
  // a value; offering anything there would invent paths that do not exist.
  assertEquals(keysOf({ title: 1, done: 2 }), ["title", "done"]);
  assertEquals(keysOf(["a", "b", "c"]), ["0", "1", "2"]);
  assertEquals(keysOf([]), []);
  assertEquals(keysOf({}), []);
  for (const leaf of ["text", 42, true, null, undefined]) {
    assertEquals(keysOf(leaf), [], String(leaf));
  }
});

Deno.test("shaping: a typed path splits into parent and replacement prefix", () => {
  // The prefix is what stops a completed deep path collapsing to its last
  // segment — the shell replaces the whole word.
  assertEquals(splitPathPrefix("items"), { parentPath: "", prefix: "" });
  assertEquals(splitPathPrefix("items/"), {
    parentPath: "items",
    prefix: "items/",
  });
  assertEquals(splitPathPrefix("items/0/ti"), {
    parentPath: "items/0",
    prefix: "items/0/",
  });
});

Deno.test("shaping: a link endpoint prefix never doubles the separator", () => {
  // `id//key` would be a different, invalid reference.
  assertEquals(linkEndpointPrefix("fid1:a", ""), "fid1:a/");
  assertEquals(linkEndpointPrefix("fid1:a", "items"), "fid1:a/items/");
  assertEquals(linkEndpointPrefix("fid1:a", "items/0"), "fid1:a/items/0/");
});
