// deno-lint-ignore-file cf-imports/no-inline-module-import -- each test drives
// its own copy of the command tree, which reads the environment as it is built;
// the query string is what makes the copy.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { exec } from "../commands/exec.ts";
import { test as testCommand } from "../commands/test-command.ts";
import { cf, checkStderr, stripAnsi, withEnv } from "./utils.ts";

class ExitError extends Error {
  constructor(readonly code: number) {
    super(`Deno.exit(${code})`);
  }
}

async function withMockExit(
  callback: () => Promise<void>,
): Promise<number | null> {
  const originalExit = Deno.exit;
  Deno.exit = ((code?: number): never => {
    throw new ExitError(code ?? 0);
  }) as typeof Deno.exit;

  try {
    await callback();
    return null;
  } catch (error) {
    if (error instanceof ExitError) return error.code;
    throw error;
  } finally {
    Deno.exit = originalExit;
  }
}

async function withCapturedErrors(
  callback: () => Promise<void>,
): Promise<string[]> {
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.join(" "));
  };

  try {
    await callback();
  } finally {
    console.error = originalError;
  }

  return errors;
}

describe("main command", () => {
  it("keeps command usage aligned with accepted positional syntax", async () => {
    const { main } = await import(
      "../commands/main.ts?main-command-usage-test"
    );
    const commands = [main];
    const mismatchedUsage: string[] = [];
    const customUsageCommands = new Set(["cf call", "cf call"]);

    for (const command of commands) {
      commands.push(...command.getCommands());
      if (customUsageCommands.has(command.getPath())) continue;

      const typedArguments = command.getArgsDefinition();
      if (!typedArguments) continue;

      const untypedArguments = typedArguments.replaceAll(/:[^>\]]+/g, "");
      const usage = command.getUsage();
      const expectedArguments = [typedArguments, untypedArguments];
      const matches = expectedArguments.some((expected) =>
        usage.endsWith(expected)
      );
      if (!matches) {
        mismatchedUsage.push(
          `${command.getPath()}: expected usage to end with ${
            expectedArguments.join(" or ")
          }, got ${usage}`,
        );
      }
    }

    expect(mismatchedUsage).toEqual([]);
  });

  it("tells a caller what a same-id retry costs, on every waiting flag", async () => {
    // Both waiting flags invite a retry, and a retry runs the handler body
    // again — at-most-once is per commit, not per execution. `--wait` is the
    // sharper case: an expiry is exactly when the caller cannot tell whether
    // the handling committed. The two sit adjacent in `--help`, so a caveat
    // on one and silence on the other reads as a real difference between
    // them.
    const { code, stdout, stderr } = await cf("call --help");
    checkStderr(stderr);
    const help = stripAnsi(stdout.join("\n")).replaceAll(/\s+/g, " ");
    expect(help).toContain(
      "Re-invoking under the same id and session cannot commit twice — but " +
        "it runs the handler body again",
    );
    expect(help).toContain(
      "recovers it too, but runs the handler body again",
    );
    expect(code).toBe(0);
  });

  it("describes and parses piece call's accepted input forms", async () => {
    const { pieceDataCommand } = await import(
      "../commands/piece.ts?piece-call-usage-test"
    );
    const call = pieceDataCommand("call");
    const expectedUsage =
      "--identity <identity> --url <url> --api-url <api-url> --space <space> " +
      "--piece <piece> [address] <callable> [input]";

    expect(call.getArgsDefinition()).toBe(
      "<callable:string> [tail...:string]",
    );
    expect(call.getUsage()).toBe(expectedUsage);
    const { code, stdout, stderr } = await cf("call --help");
    checkStderr(stderr);
    const help = stripAnsi(stdout.join("\n"));
    const renderedUsage = help.split("\n").find((line) =>
      line.trimStart().startsWith("Usage:")
    );
    expect(renderedUsage?.replaceAll(/\s+/g, " ").trim()).toBe(
      `Usage: cf call ${expectedUsage}`,
    );
    const normalizedHelp = help.replaceAll(/\s+/g, " ");
    expect(normalizedHelp).toContain(
      `The callable name separates piece-call options from the callable's arguments. Arguments after the callable use the same parser as cf exec. Use --json with an optional inline value for complete JSON input; bare --json reads JSON from stdin. A single positional JSON value or "-" stdin sentinel is also accepted. Use --help --json for machine-readable schema help. Put schema-derived flags after --. Handlers interpret piped input when no input argument is present.`,
    );
    expect(code).toBe(0);

    const parsedCalls: Array<{
      positionals: unknown[];
      literalArguments: string[];
    }> = [];
    call.action(function (_options, ...positionals) {
      parsedCalls.push({
        positionals,
        literalArguments: this.getLiteralArgs(),
      });
    });
    await call.parse(["search", '{"query":"tea"}']);
    await call.parse(["search", "--help"]);
    await call.parse(["search", "-"]);
    await call.parse(["search", "--", "--json"]);
    expect(parsedCalls).toEqual([
      {
        positionals: ["search", '{"query":"tea"}'],
        literalArguments: [],
      },
      { positionals: ["search", "--help"], literalArguments: [] },
      { positionals: ["search", "-"], literalArguments: [] },
      { positionals: ["search"], literalArguments: ["--json"] },
    ]);
  });

  it("reads piece call's invocation session from `CF_INVOCATION_SESSION`, behind `--invocation-session`", async () => {
    const { pieceDataCommand } = await import(
      "../commands/piece.ts?piece-call-session-test"
    );
    const call = pieceDataCommand("call");
    const sessions: Array<string | undefined> = [];
    call.action((options: { invocationSession?: string }) => {
      sessions.push(options.invocationSession);
    });

    await withEnv("CF_INVOCATION_SESSION", "from-env", async () => {
      await call.parse([
        "--invocation-session",
        "from-flag",
        "increment",
      ]);
      await call.parse(["increment"]);
    });
    await withEnv("CF_INVOCATION_SESSION", undefined, async () => {
      await call.parse(["increment"]);
    });

    // The environment is the standing default for a shell or an agent run,
    // and the flag is the one call that departs from it — so the flag wins.
    // With neither, the option arrives `undefined`: this is the option layer
    // alone, and `resolveInvocationIdentity` is what goes on to mint a
    // session for a caller that named none.
    //
    // The middle reading is the one that pins the env var to this option:
    // the variable is declared under the `CF_` prefix, and what reaches
    // `.invocationSession` is the remainder camel-cased. A name whose
    // remainder camel-cases to anything else would leave that reading
    // `undefined` while the flag readings stayed green.
    expect(sessions).toEqual(["from-flag", "from-env", undefined]);
  });

  it("rejects multiple inline inputs to piece call", async () => {
    const { main } = await import(
      "../commands/main.ts?piece-call-inline-validation-test"
    );
    await expect(
      main.parse([
        "call",
        "--identity",
        "./identity.key",
        "--api-url",
        "https://cf.dev",
        "--space",
        "common-knowledge",
        "--piece",
        "abcdefghijklmnopqrstuvwxyz",
        "search",
        '{"query":"tea"}',
        '{"limit":5}',
      ]),
    ).rejects.toThrow(
      'Use a single inline JSON argument or "--" before schema-derived flags.',
    );
  });

  it("mounts the data commands at top level and nowhere under piece", async () => {
    // The removal is only observable as an absence, so it needs its own
    // assertion: every other test here names a command that exists, and would
    // pass unchanged if `cf piece get` came back.
    const { main } = await import(
      "../commands/main.ts?piece-data-absence"
    );
    const top = main.getCommands().map((command) => command.getName());
    expect(top).toContain("get");
    expect(top).toContain("set");
    expect(top).toContain("call");

    const piece = main.getCommands().find((command) =>
      command.getName() === "piece"
    );
    expect(piece).toBeDefined();
    const nested = piece!.getCommands(true).map((command) => command.getName());
    expect(nested).not.toContain("get");
    expect(nested).not.toContain("set");
    expect(nested).not.toContain("call");
    // The lifecycle commands that merely start with the same word stay.
    expect(nested).toContain("setsrc");
    expect(nested).toContain("getsrc");
    expect(nested).toContain("get-label");
    expect(nested).toContain("set-label");
  });

  it("registers visible commands and reports configured environment defaults", async () => {
    await withEnv("CF_IDENTITY", "./identity.key", async () => {
      await withEnv("CF_API_URL", "http://127.0.0.1:8000", async () => {
        const { main } = await import(
          "../commands/main.ts?main-command-test"
        );

        const commandNames = main.getCommands().map((command) =>
          command.getName()
        );
        expect(commandNames).toContain("view");
        // A command that is not registered is invisible: `cf ingest` would
        // simply not exist, with no error anywhere to say why.
        expect(commandNames).toContain("ingest");
        expect(commandNames).toContain("fuse-daemon");
        expect(commandNames).toContain("fuse-supervisor");
        expect(commandNames).not.toContain("dev");
        expect(commandNames).not.toContain("deploy");

        const allCommandNames = main.getCommands(true).map((command) =>
          command.getName()
        );
        expect(allCommandNames).not.toContain("dev");
        expect(allCommandNames).not.toContain("deploy");
        main.getHelp();

        const description = main.getDescription();
        expect(description).toContain("ENVIRONMENT:");
        expect(description).toContain(
          "CF_IDENTITY = ./identity.key (set, no need to pass --identity)",
        );
        expect(description).toContain(
          "CF_API_URL  = http://127.0.0.1:8000 (set, no need to pass --api-url)",
        );
      });
    });
  });

  it("shows exec command help before trying to resolve a mounted file", async () => {
    const { code, stdout } = await cf("exec --help");
    const help = stripAnsi(stdout.join("\n"));

    expect(code).toBe(0);
    expect(help).toContain(
      "Execute a mounted callable file from a Common Fabric FUSE mount.",
    );
    expect(help).not.toContain("not within a mounted cf fuse");
  });

  it("shows help for the direct FUSE daemon entry point", async () => {
    const { code, stdout } = await cf("fuse-daemon --help");

    expect(code).toBe(0);
    expect(stripAnsi(stdout.join("\n"))).toContain(
      "Usage:   cf fuse-daemon <mountpoint> [options]",
    );
  });

  it("shows the supervisor's own help for the direct supervisor entry point", async () => {
    // The subcommand forwards its raw argv to the supervisor's parser, so the
    // compiled binary and a direct `deno run` of the supervisor produce the
    // same flags and the same help.
    const { code, stdout } = await cf("fuse-supervisor --help");

    expect(code).toBe(0);
    expect(stdout.join("\n")).toContain(
      "Usage: fuse-supervisor <mountpoint> [options]",
    );
    expect(stdout.join("\n")).toContain("--supervisor-status <path>");
  });

  it("rejects an unknown flag on the direct supervisor entry point", async () => {
    const { code, stdout, stderr } = await cf("fuse-supervisor /mnt --json");

    expect(code).not.toBe(0);
    expect(stdout).toEqual([]);
    expect(stripAnsi(stderr.join("\n"))).toContain(
      "Unknown fuse supervisor option: --json",
    );
  });

  it("keeps rejection help off stdout when --json is unsupported", async () => {
    const { code, stdout, stderr } = await cf("acl --json");

    expect(code).not.toBe(0);
    expect(stdout).toEqual([]);
    expect(stripAnsi(stderr.join("\n"))).toContain(
      'Unknown option "--json"',
    );
  });

  it("reports mounted exec errors without a stack", async () => {
    const errors = await withCapturedErrors(async () => {
      const code = await withMockExit(async () => {
        await exec.parse(["/tmp/not-mounted.handler"]);
      });

      expect(code).toBe(1);
    });

    expect(errors).toEqual([
      "Path is not within a mounted cf fuse filesystem: /tmp/not-mounted.handler",
    ]);
  });

  it("reports missing pattern test paths", async () => {
    const errors = await withCapturedErrors(async () => {
      const code = await withMockExit(async () => {
        await testCommand.parse(["./no-such-file.test.tsx"]);
      });

      expect(code).toBe(1);
    });

    expect(errors[0]).toContain("Error: Path not found:");
    expect(errors[0]).toContain("no-such-file.test.tsx");
  });

  it("reports empty pattern test globs", async () => {
    const errors = await withCapturedErrors(async () => {
      const code = await withMockExit(async () => {
        await testCommand.parse(["./no-such-*.test.tsx"]);
      });

      expect(code).toBe(1);
    });

    expect(errors).toEqual(["Error: No test files found"]);
  });

  it("skips glob matches that are not pattern tests", async () => {
    const dir = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(join(dir, "notes.txt"), "not a test");
      const errors = await withCapturedErrors(async () => {
        const code = await withMockExit(async () => {
          await testCommand.parse([`${dir}/*`]);
        });

        expect(code).toBe(1);
      });

      expect(errors).toEqual(["Error: No test files found"]);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  it("reports a directory holding no pattern tests", async () => {
    const dir = await Deno.makeTempDir();
    try {
      const errors = await withCapturedErrors(async () => {
        const code = await withMockExit(async () => {
          await testCommand.parse([dir]);
        });

        expect(code).toBe(1);
      });

      expect(errors).toEqual(["Error: No test files found"]);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  it("reports a pattern test path that cannot be read", async () => {
    const file = await Deno.makeTempFile();
    try {
      // Descending into a regular file fails as NotADirectory, which is the
      // path's other error branch.
      const errors = await withCapturedErrors(async () => {
        const code = await withMockExit(async () => {
          await testCommand.parse([join(file, "child.test.tsx")]);
        });

        expect(code).toBe(1);
      });

      expect(errors[0]).toContain("Error accessing path");
    } finally {
      await Deno.remove(file);
    }
  });

  it("reports a pattern test path that is neither a file nor a directory", {
    ignore: Deno.build.os === "windows",
  }, async () => {
    const errors = await withCapturedErrors(async () => {
      const code = await withMockExit(async () => {
        await testCommand.parse(["/dev/null"]);
      });

      expect(code).toBe(1);
    });

    expect(errors[0]).toContain("is not a file or directory");
  });
});
