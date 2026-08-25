import { assert, assertEquals } from "@std/assert";
import { resolveCompletionLine } from "../lib/completion/line.ts";
import {
  descendProjection,
  keysOf,
  linkEndpointPrefix,
  liveCandidates,
  projectionKeys,
  resolveSpaceContext,
  shapePieceCandidates,
  shapeProjectionCandidates,
  shapeSlugCandidates,
  shapeVerbCandidates,
  splitPathPrefix,
  splitSelectPrefix,
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

Deno.test("space context: an embedded space supplies one the line did not name", async () => {
  // A canonical reference carries the space DID, which is the one spelling a
  // line can name a space with and never write `--space`.
  await withEnv({ identity: "/env.key", apiUrl: "http://env:9999" }, () => {
    const config = resolveSpaceContext(
      lineFor("cf get --piece /@did:key:zEmbedded/of:fid1:abc "),
      "did:key:zEmbedded",
    );
    assert(config);
    assertEquals(config.space, "did:key:zEmbedded");
  });
});

Deno.test("space context: the line's own --space wins over an embedded one", async () => {
  // Which of the two is right is the command's judgment to make; completion
  // offers candidates and defers, so it reads the space the caller wrote.
  await withEnv({ identity: "/env.key", apiUrl: "http://env:9999" }, () => {
    assertEquals(
      resolveSpaceContext(
        lineFor("cf get -s team --piece /@did:key:zEmbedded/of:fid1:abc "),
        "did:key:zEmbedded",
      )?.space,
      "team",
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

Deno.test("live candidates: every path-shaped slot hands the shell its own directive", async () => {
  // One entry per reachable directive in the provider tables, asserting the
  // glob as well as the kind. A wrong glob is the "wrong set" defect in its
  // quietest form: the slot still answers, with the wrong files, and nothing
  // upstream can tell. These read no state, so this is where they belong —
  // the integration walkthrough covers the providers that reach a fabric and
  // deliberately does not re-check these.
  const cases: Array<[string, string, string | undefined]> = [
    ["cf piece ls -i ", "files", "*.key"],
    ["cf id did ", "files", "*.key"],
    ["cf piece new --root ", "dirs", undefined],
    ["cf piece new --test ", "files", "*.tsx"],
    ["cf piece new ", "files", "*.tsx"],
    ["cf piece setsrc ", "files", "*.tsx"],
    ["cf check ", "files", "*.tsx"],
    ["cf test ", "files", "*.tsx"],
    ["cf piece new --datafile ", "files", undefined],
    ["cf view ", "files", undefined],
    ["cf exec ", "files", undefined],
    ["cf space clone --to ", "dirs", undefined],
    ["cf space verify ", "dirs", undefined],
    ["cf space reset ", "dirs", undefined],
  ];
  for (const [text, kind, glob] of cases) {
    const result = await liveCandidates(lineFor(text));
    assertEquals(result.directives.length, 1, `${text} emits one directive`);
    const directive = result.directives[0] as { kind: string; glob?: string };
    assertEquals(directive.kind, kind, text);
    assertEquals(directive.glob, glob, `${text} glob`);
  }
});

Deno.test("live candidates: a fabric slot without context degrades to empty", async () => {
  // Mid-keystroke with nothing configured: silence, not an error.
  await withEnv({}, async () => {
    for (
      const text of [
        "cf piece call --piece x ",
        "cf piece get --piece x ",
        "cf piece get-label --piece x ",
        "cf piece set-label --piece x ",
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

Deno.test("shaping: a piece is labeled by name, falling back to its pattern", () => {
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

Deno.test("shaping: a slug is labeled apart from the ids beside it", () => {
  // Both are `--piece` values, so a candidate list mixing them has to say
  // which is which — and where the slug resolves to a piece the listing named,
  // what it points at is the question a caller is actually asking.
  assertEquals(
    shapeSlugCandidates(
      [
        { slug: "board", piece: "fid1:a" },
        { slug: "orphan", piece: "fid1:missing" },
        { slug: "unresolved" },
      ],
      [{ id: "fid1:a", name: "Completion fixture" }],
    ),
    [
      { value: "board", description: "slug for Completion fixture" },
      { value: "orphan", description: "slug" },
      { value: "unresolved", description: "slug" },
    ],
  );
});

Deno.test("shaping: a projection word splits into the part carried back and the path", () => {
  // The shell replaces the whole word, so a candidate has to carry every
  // element already closed and every segment already typed in this one.
  assertEquals(splitSelectPrefix(""), {
    list: "",
    path: [],
    prefix: "",
    atElementStart: true,
  });
  assertEquals(splitSelectPrefix("settings."), {
    list: "",
    path: ["settings"],
    prefix: "settings.",
    atElementStart: false,
  });
  assertEquals(splitSelectPrefix("items@,settings.the"), {
    list: "items@,",
    path: ["settings"],
    prefix: "settings.",
    atElementStart: false,
  });
  assertEquals(splitSelectPrefix("revision,"), {
    list: "revision,",
    path: [],
    prefix: "",
    atElementStart: true,
  });
});

Deno.test("shaping: a projection path reads through however many array layers it meets", () => {
  // `--select matrix.nested.leaf` is valid over `[[{nested: {leaf}}]]`, so a
  // walk that unwrapped one layer would offer `nested` and then nothing.
  const nested = { matrix: [[{ nested: { leaf: 1 } }]] };
  assertEquals(projectionKeys(descendProjection(nested, ["matrix"])), [
    "nested",
  ]);
  assertEquals(
    projectionKeys(descendProjection(nested, ["matrix", "nested"])),
    ["leaf"],
  );
});

Deno.test("shaping: the bare address suffix is offered at any element of the list", () => {
  // `revision,@` parses: a path that is only the suffix is legal wherever an
  // element begins, not only at the first.
  assertEquals(
    shapeProjectionCandidates({ a: 1 }, "revision,", { self: true })[0].value,
    "revision,@",
  );
});

Deno.test("shaping: a projection path reads an array element-wise", () => {
  // `--select items.title` projects each element; `--select items.0.title` is
  // refused. Offering an index would name a path the command rejects.
  assertEquals(
    projectionKeys(descendProjection(
      { items: [{ title: "a" }, { title: "b", pinned: true }] },
      ["items"],
    )),
    ["title", "pinned"],
  );
  assertEquals(projectionKeys([{ a: 1 }, { b: 2 }]), ["a", "b"]);
  assertEquals(projectionKeys({ a: 1 }), ["a"]);
  for (const leaf of ["text", 42, true, null, undefined]) {
    assertEquals(projectionKeys(leaf), [], String(leaf));
  }
});

Deno.test("shaping: both spellings of a position are offered, each carrying the prefix", () => {
  assertEquals(
    shapeProjectionCandidates({ theme: "dark" }, "settings."),
    [
      { value: "settings.theme" },
      { value: "settings.theme@", description: "its address" },
    ],
  );
});

Deno.test("shaping: the bare address suffix is offered only where it is asked for", () => {
  const withSelf = shapeProjectionCandidates({ a: 1 }, "", { self: true });
  assertEquals(withSelf[0].value, "@");
  assertEquals(
    shapeProjectionCandidates({ a: 1 }, "").map((c) => c.value),
    ["a", "a@"],
  );
});

Deno.test("shaping: a key the concise grammar cannot carry is not offered", () => {
  // `parseConciseSegment` holds a segment to an identifier grammar, and a
  // trailing `@` in a name reads as the address suffix. Offering either would
  // name a path the command refuses.
  assertEquals(
    shapeProjectionCandidates({ "ok": 1, "not ok": 2, "trailing@": 3 }, "")
      .map((candidate) => candidate.value),
    ["ok", "ok@"],
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
