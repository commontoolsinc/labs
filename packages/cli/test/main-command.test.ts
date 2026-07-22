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
    const customUsageCommands = new Set(["cf piece call"]);

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

  it("describes and parses piece call's accepted input forms", async () => {
    const { piece } = await import(
      "../commands/piece.ts?piece-call-usage-test"
    );
    const call = piece.getCommand("call")!;
    const expectedUsage =
      "--identity <identity> --url <url> --api-url <api-url> --space <space> --piece <piece> <callable> [input]";

    expect(call.getArgsDefinition()).toBe(
      "<callable:string> [tail...:string]",
    );
    expect(call.getUsage()).toBe(expectedUsage);
    const { code, stdout, stderr } = await cf("piece call --help");
    checkStderr(stderr);
    const help = stripAnsi(stdout.join("\n"));
    const renderedUsage = help.split("\n").find((line) =>
      line.trimStart().startsWith("Usage:")
    );
    expect(renderedUsage?.replaceAll(/\s+/g, " ").trim()).toBe(
      `Usage: cf piece call ${expectedUsage}`,
    );
    const normalizedHelp = help.replaceAll(/\s+/g, " ");
    expect(normalizedHelp).toContain(
      `INPUT: Pass one inline JSON value, or put "--" before flags generated from the callable's input schema. Handlers interpret piped input using their input schema. Tools read piped JSON when called with "-- --json".`,
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
    await piece.parse(["call", "search", '{"query":"tea"}']);
    await piece.parse(["call", "search", "--help"]);
    await piece.parse(["call", "search", "--", "--json"]);
    expect(parsedCalls).toEqual([
      {
        positionals: ["search", '{"query":"tea"}'],
        literalArguments: [],
      },
      { positionals: ["search", "--help"], literalArguments: [] },
      { positionals: ["search"], literalArguments: ["--json"] },
    ]);
  });

  it("rejects multiple inline inputs to piece call", async () => {
    const { main } = await import(
      "../commands/main.ts?piece-call-inline-validation-test"
    );
    const errors = await withCapturedErrors(async () => {
      const code = await withMockExit(async () => {
        await main.parse([
          "piece",
          "--identity",
          "./identity.key",
          "--api-url",
          "https://cf.dev",
          "--space",
          "common-knowledge",
          "call",
          "--piece",
          "abcdefghijklmnopqrstuvwxyz",
          "search",
          '{"query":"tea"}',
          '{"limit":5}',
        ]);
      });

      expect(code).toBe(1);
    });

    expect(errors).toEqual([
      'Use a single inline JSON argument or "--" before schema-derived flags.',
    ]);
  });

  it("registers view and reports configured environment defaults", async () => {
    await withEnv("CF_IDENTITY", "./identity.key", async () => {
      await withEnv("CF_API_URL", "http://127.0.0.1:8000", async () => {
        const { main } = await import(
          "../commands/main.ts?main-command-test"
        );

        const commandNames = main.getCommands().map((command) =>
          command.getName()
        );
        expect(commandNames).toContain("view");

        const description = main.getDescription();
        expect(description).toContain("ENVIRONMENT:");
        expect(description).toContain(
          "CF_IDENTITY = ./identity.key (set, no need to pass --identity)",
        );
        expect(description).toContain(
          "CF_API_URL  = http://127.0.0.1:8000 (set, no need to pass --api-url)",
        );

        const logs: string[] = [];
        const originalLog = console.log;
        console.log = (...args: unknown[]) => {
          logs.push(args.join(" "));
        };
        try {
          await main.parse(["deploy"]);
        } finally {
          console.log = originalLog;
        }

        expect(logs).toEqual([
          "The 'deploy' command does not exist. Use 'cf piece new' to deploy a pattern.",
        ]);
      });
    });
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
