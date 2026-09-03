/** Tests the stable server-execution CI role mapping. */

import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import { SERVER_EXECUTION_DEFAULT_ENABLED } from "@commonfabric/memory/v2/server-execution-default";
import {
  assertServerExecutionCiPosture,
  runServerExecutionCiCommand,
  serverExecutionCiEnvironment,
  serverExecutionCiLane,
} from "./server-execution-ci.ts";

describe("server-execution-ci", () => {
  it("resolves the default role from the first-party constant", () => {
    expect(serverExecutionCiLane("default").enabled).toBe(
      SERVER_EXECUTION_DEFAULT_ENABLED,
    );
  });

  it("keeps the documented current posture aligned with the default", async () => {
    const registry = await Deno.readTextFile(
      new URL(
        "../docs/development/EXPERIMENTAL_OPTIONS.md",
        import.meta.url,
      ),
    );
    const summary = registry.split("\n").find((line) =>
      line.startsWith("| [`serverExecution`](#serverexecution)")
    );
    expect(summary).toBeDefined();
    // The whole status cell, so the posture word, the constant's value and
    // the explicit arm cannot drift apart from each other or from the code.
    // The wording is direction-neutral on purpose: the explicit value is
    // "the other arm" whichever way the default points (it is the rollback
    // lever only while the default is ON), so a flip changes the values in
    // the cell and never its phrasing.
    const enabled = SERVER_EXECUTION_DEFAULT_ENABLED;
    expect(summary!).toContain(
      `| **${enabled ? "on" : "off"}** ` +
        `(\`SERVER_EXECUTION_DEFAULT_ENABLED = ${enabled}\`; ` +
        `explicit \`${!enabled}\` selects the other arm) |`,
    );
  });

  it("runs as the program the workflow invokes, with no permissions", async () => {
    // CI's resolve and probe steps run the adapter as a program
    // (`deno run tasks/server-execution-ci-command.ts …`, no flags), so it is
    // exercised the same way: it needs no permission, prints exactly the
    // library's lines, and turns a bad role into a failing step.
    const adapter = fromFileUrl(
      new URL("./server-execution-ci-command.ts", import.meta.url),
    );
    const run = (...args: string[]) =>
      new Deno.Command(Deno.execPath(), {
        args: ["run", adapter, ...args],
        cwd: fromFileUrl(new URL("..", import.meta.url)),
        stdout: "piped",
        stderr: "piped",
      }).output();

    const env = await run("env", "opposite");
    expect(env.success).toBe(true);
    expect(new TextDecoder().decode(env.stdout)).toBe(
      `${serverExecutionCiEnvironment("opposite").join("\n")}\n`,
    );

    const bad = await run("env", "sideways");
    expect(bad.code).toBe(1);
    expect(new TextDecoder().decode(bad.stderr)).toContain(
      "Expected server-execution CI role",
    );
  });

  for (const defaultEnabled of [false, true]) {
    describe(`with the default ${defaultEnabled ? "ON" : "OFF"}`, () => {
      it("leaves the default role implicit and selects its opposite explicitly", () => {
        const defaultLane = serverExecutionCiLane("default", defaultEnabled);
        const oppositeLane = serverExecutionCiLane(
          "opposite",
          defaultEnabled,
        );

        expect(defaultLane).toEqual({
          role: "default",
          enabled: defaultEnabled,
          label: defaultEnabled ? "ON" : "OFF",
        });
        expect(oppositeLane).toEqual({
          role: "opposite",
          enabled: !defaultEnabled,
          label: defaultEnabled ? "OFF" : "ON",
          recordVariant: defaultEnabled
            ? "server-execution-off"
            : "server-execution",
          experimentalValue: defaultEnabled ? "false" : "true",
        });
      });

      it("exports the actual arm and only makes the opposite role explicit", () => {
        expect(
          serverExecutionCiEnvironment("default", defaultEnabled),
        ).toEqual([
          `SERVER_EXECUTION_ENABLED=${defaultEnabled}`,
          "CF_TEST_RECORDS_VARIANT=",
        ]);
        expect(
          serverExecutionCiEnvironment("opposite", defaultEnabled),
        ).toEqual([
          `SERVER_EXECUTION_ENABLED=${!defaultEnabled}`,
          `CF_TEST_RECORDS_VARIANT=${
            defaultEnabled ? "server-execution-off" : "server-execution"
          }`,
          `EXPERIMENTAL_SERVER_EXECUTION=${!defaultEnabled}`,
        ]);
      });

      it("accepts a uniform server and baked-shell posture", () => {
        for (const role of ["default", "opposite"] as const) {
          const lane = serverExecutionCiLane(role, defaultEnabled);
          expect(() =>
            assertServerExecutionCiPosture(
              role,
              {
                experimental: { serverExecution: lane.enabled },
                shellServerExecutionDefine: lane.experimentalValue ?? null,
              },
              { servingLoop: lane.enabled ? {} : null },
              defaultEnabled,
            )
          ).not.toThrow();
        }
      });
    });
  }

  it("rejects mixed and misreported postures", () => {
    expect(() =>
      assertServerExecutionCiPosture(
        "default",
        {
          experimental: { serverExecution: true },
          shellServerExecutionDefine: null,
        },
        { servingLoop: null },
        true,
      )
    ).toThrow("serving loop is absent");
    expect(() =>
      assertServerExecutionCiPosture(
        "opposite",
        {
          experimental: { serverExecution: true },
          shellServerExecutionDefine: "false",
        },
        { servingLoop: null },
        true,
      )
    ).toThrow("publishes serverExecution=true");
    expect(() =>
      assertServerExecutionCiPosture(
        "opposite",
        {
          experimental: { serverExecution: false },
          shellServerExecutionDefine: "true",
        },
        { servingLoop: null },
        true,
      )
    ).toThrow("shell define is true");
  });

  it("runs the environment command and rejects malformed commands", async () => {
    const logged: string[] = [];
    await runServerExecutionCiCommand(
      ["env", "opposite"],
      fetch,
      (message) => logged.push(message),
    );
    expect(logged).toEqual([
      serverExecutionCiEnvironment("opposite").join("\n"),
    ]);

    await expect(
      runServerExecutionCiCommand(["env", "sideways"]),
    ).rejects.toThrow("Expected server-execution CI role");
    await expect(
      runServerExecutionCiCommand(["probe", "default"]),
    ).rejects.toThrow("Expected `env <role>` or `probe <role> <toolshed-url>`");
  });

  it("probes both roles and reports HTTP failures", async () => {
    const requested: string[] = [];
    const logged: string[] = [];
    for (const role of ["default", "opposite"] as const) {
      const lane = serverExecutionCiLane(role);
      const fetcher = (input: string | URL | Request): Promise<Response> => {
        const url = String(input);
        requested.push(url);
        const body = url.endsWith("/api/meta")
          ? {
            experimental: { serverExecution: lane.enabled },
            shellServerExecutionDefine: lane.experimentalValue ?? null,
          }
          : { servingLoop: lane.enabled ? {} : null };
        return Promise.resolve(Response.json(body));
      };
      await runServerExecutionCiCommand(
        ["probe", role, "https://example.test/"],
        fetcher,
        (message) => logged.push(message),
      );
    }
    expect(requested).toEqual([
      "https://example.test/api/meta",
      "https://example.test/api/health/stats",
      "https://example.test/api/meta",
      "https://example.test/api/health/stats",
    ]);
    expect(logged).toEqual([
      `Verified default server-execution lane (${
        serverExecutionCiLane("default").label
      }).`,
      `Verified opposite server-execution lane (${
        serverExecutionCiLane("opposite").label
      }).`,
    ]);

    const failedFetch = (input: string | URL | Request): Promise<Response> =>
      Promise.resolve(
        new Response(null, {
          status: String(input).endsWith("/api/meta") ? 503 : 500,
        }),
      );
    await expect(
      runServerExecutionCiCommand(
        ["probe", "default", "https://example.test"],
        failedFetch,
      ),
    ).rejects.toThrow("meta=503, stats=500");
  });
});
