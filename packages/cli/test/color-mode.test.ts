import { assert, assertEquals, assertFalse } from "@std/assert";
import { getColorEnabled, setColorEnabled } from "@std/fmt/colors";
import {
  extractNoColor,
  resolveColorEnabled,
  safeEnvGet,
} from "../lib/color-mode.ts";
import { main } from "../commands/main.ts";

const noEnv = () => undefined;

Deno.test("extractNoColor strips the flag and reports it", () => {
  assertEquals(extractNoColor(["--no-color", "piece", "ls"]), {
    noColor: true,
    args: ["piece", "ls"],
  });
  assertEquals(extractNoColor(["piece", "ls"]), {
    noColor: false,
    args: ["piece", "ls"],
  });
});

Deno.test("extractNoColor leaves payload args after -- untouched", () => {
  // `--no-color` after `--` is a schema-derived flag for the target handler,
  // not a color directive; eating it would silently drop handler input.
  assertEquals(
    extractNoColor(["piece", "call", "h", "--", "--no-color", "x"]),
    {
      noColor: false,
      args: ["piece", "call", "h", "--", "--no-color", "x"],
    },
  );
  // Both positions: the leading one is consumed, the payload one survives.
  assertEquals(
    extractNoColor(["--no-color", "piece", "call", "h", "--", "--no-color"]),
    {
      noColor: true,
      args: ["piece", "call", "h", "--", "--no-color"],
    },
  );
});

Deno.test("safeEnvGet returns undefined instead of throwing", () => {
  // A present var reads through.
  Deno.env.set("CF_COLOR_MODE_TEST", "x");
  try {
    assertEquals(safeEnvGet("CF_COLOR_MODE_TEST"), "x");
  } finally {
    Deno.env.delete("CF_COLOR_MODE_TEST");
  }
  // An unset var is undefined, not an error.
  assertEquals(safeEnvGet("CF_DEFINITELY_UNSET_VAR_XYZ"), undefined);
  // An invalid key (empty string) makes Deno.env.get throw — swallowed.
  assertEquals(safeEnvGet(""), undefined);
});

Deno.test("resolveColorEnabled follows a TTY by default", () => {
  assert(resolveColorEnabled({
    noColorFlag: false,
    denoNoColor: false,
    isTerminal: true,
    env: noEnv,
  }));
  assertFalse(resolveColorEnabled({
    noColorFlag: false,
    denoNoColor: false,
    isTerminal: false,
    env: noEnv,
  }));
});

Deno.test("resolveColorEnabled disable overrides win over everything", () => {
  const forceEnv = (key: string) => key === "FORCE_COLOR" ? "1" : undefined;
  assertFalse(resolveColorEnabled({
    noColorFlag: true,
    denoNoColor: false,
    isTerminal: true,
    env: forceEnv,
  }));
  assertFalse(resolveColorEnabled({
    noColorFlag: false,
    denoNoColor: true,
    isTerminal: true,
    env: forceEnv,
  }));
});

Deno.test("resolveColorEnabled: NO_COLOR wins over both force vars (raw env)", () => {
  // Reproduces the live bug at the env level: with NO_COLOR set, color must
  // stay off regardless of FORCE_COLOR/CLICOLOR_FORCE. denoNoColor is false
  // here because Deno pre-arbitrates FORCE_COLOR over NO_COLOR — the resolver
  // must consult the raw NO_COLOR var, not just the pre-arbitrated flag.
  assertFalse(resolveColorEnabled({
    noColorFlag: false,
    denoNoColor: false,
    isTerminal: true,
    env: (key) =>
      key === "NO_COLOR" ? "1" : key === "FORCE_COLOR" ? "1" : undefined,
  }));
  assertFalse(resolveColorEnabled({
    noColorFlag: false,
    denoNoColor: false,
    isTerminal: true,
    env: (key) =>
      key === "NO_COLOR" ? "1" : key === "CLICOLOR_FORCE" ? "1" : undefined,
  }));
  // An empty NO_COLOR is "unset" per the NO_COLOR spec — force still wins.
  assert(resolveColorEnabled({
    noColorFlag: false,
    denoNoColor: false,
    isTerminal: false,
    env: (key) =>
      key === "NO_COLOR" ? "" : key === "FORCE_COLOR" ? "1" : undefined,
  }));
});

Deno.test("resolveColorEnabled honors FORCE_COLOR / CLICOLOR_FORCE when piped", () => {
  assert(resolveColorEnabled({
    noColorFlag: false,
    denoNoColor: false,
    isTerminal: false,
    env: (key) => key === "FORCE_COLOR" ? "1" : undefined,
  }));
  assert(resolveColorEnabled({
    noColorFlag: false,
    denoNoColor: false,
    isTerminal: false,
    env: (key) => key === "CLICOLOR_FORCE" ? "1" : undefined,
  }));
  // "0" and "" do not force
  assertFalse(resolveColorEnabled({
    noColorFlag: false,
    denoNoColor: false,
    isTerminal: false,
    env: (key) => key === "FORCE_COLOR" ? "0" : undefined,
  }));
  assertFalse(resolveColorEnabled({
    noColorFlag: false,
    denoNoColor: false,
    isTerminal: false,
    env: (key) => key === "FORCE_COLOR" ? "" : undefined,
  }));
});

// Guards the invariant behind the "@std/fmt/colors" import-map pin in
// packages/cli/deno.jsonc: our setColorEnabled() must reach the same module
// instance Cliffy styles version/error output with. If Cliffy's @std/fmt
// dependency range drifts away from the pin, this test fails and the pin
// must be updated.
Deno.test("setColorEnabled controls Cliffy version output", () => {
  const previous = getColorEnabled();
  try {
    setColorEnabled(false);
    assertFalse(main.getLongVersion().includes("\x1b["));
    setColorEnabled(true);
    assert(main.getLongVersion().includes("\x1b["));
  } finally {
    setColorEnabled(previous);
  }
});

// Cliffy's HelpGenerator force-sets its own `colors` option while rendering,
// so help output is controlled through Command.help(), not setColorEnabled —
// mod.ts mirrors the resolved policy into main.help({ colors }).
Deno.test("help colors follow the Cliffy help option", () => {
  try {
    main.reset().help({ colors: false });
    assertFalse(main.getHelp().includes("\x1b["));
    const pieceGet = main.getCommand("piece")?.getCommand("get");
    assert(pieceGet, "piece get subcommand exists");
    assertFalse(
      pieceGet.getHelp().includes("\x1b["),
      "subcommands inherit the root help colors",
    );
    main.reset().help({ colors: true });
    assert(main.getHelp().includes("\x1b["));
  } finally {
    // colors: true matches the HelpGenerator default the command started with.
    main.reset().help({ colors: true });
  }
});
