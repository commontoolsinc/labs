import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { exec } from "../commands/exec.ts";
import { test as testCommand } from "../commands/test.ts";
import { withEnv } from "./utils.ts";

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
});
