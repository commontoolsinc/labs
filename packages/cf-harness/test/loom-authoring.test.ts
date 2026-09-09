/** Checks transport attribution and receipt evidence for host Loom commands. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  executeLoomAuthoringCommand,
  validateLoomAuthoringConfig,
} from "../src/loom-authoring.ts";
import type { ProcessRunRequest } from "../src/sandbox/process-runner.ts";

/** A composition the daemon committed. */
const receipt = {
  loom_id: "loom-1111111111111111",
  request_id: "collection-one",
  version: 2,
  created: true,
  component_ids: ["c-1"],
  operation_ids: ["op-1", "op-2"],
  displaced: [],
};

/** A current manifest beside the historical composition. */
const reply = {
  ok: true,
  result: {
    kind: "manifest",
    receipt,
    replayed: true,
    manifest: { loom_id: receipt.loom_id, version: 3, components: [] },
  },
};

/** Arguments retained across retries of one logical request. */
const input = {
  request_id: "collection-one",
  title: "Donut references",
  components: [{ ref: "url:https://example.com/donuts" }],
};

describe("loom-authoring", () => {
  describe("executeLoomAuthoringCommand()", () => {
    it("preserves historical receipts when only the implicit origin is missing", async () => {
      const calls: ProcessRunRequest[] = [];
      const result = await executeLoomAuthoringCommand(
        {
          cliPath: "/trusted/loom",
          boundLoomId: "loom-2222222222222222",
          transport: { kind: "broker", queuePath: "/trusted/queue" },
        },
        "loom.authoring-context",
        {},
        {
          run(request) {
            calls.push(request);
            return Promise.resolve(
              request.args.includes("--loom")
                ? {
                  exitCode: 1,
                  stderr: "",
                  stdout: JSON.stringify({ ok: false, code: "no-loom" }),
                }
                : {
                  exitCode: 0,
                  stderr: "",
                  stdout: JSON.stringify({
                    ok: true,
                    result: {
                      kind: "authoring-context",
                      historical: true,
                      run_scoped: true,
                      authored: [{ receipt }],
                      bound_loom: null,
                      truncated: false,
                    },
                  }),
                },
            );
          },
        },
      );
      expect(result).toMatchObject({
        status: "ok",
        result: {
          authored: [{ receipt }],
          bound_loom: { loom_id: "loom-2222222222222222", available: false },
        },
      });
      expect(calls).toHaveLength(2);
      expect(calls[1].args).not.toContain("--loom");
    });

    it("does not reinterpret an explicitly missing target as an unbound history read", async () => {
      let calls = 0;
      const result = await executeLoomAuthoringCommand(
        {
          cliPath: "/trusted/loom",
          boundLoomId: "loom-1111111111111111",
          transport: { kind: "broker", queuePath: "/trusted/queue" },
        },
        "loom.authoring-context",
        { loom_id: "loom-2222222222222222" },
        {
          run() {
            calls++;
            return Promise.resolve({
              exitCode: 1,
              stderr: "",
              stdout: JSON.stringify({ ok: false, code: "no-loom" }),
            });
          },
        },
      );
      expect(result).toMatchObject({
        status: "error",
        code: "no-loom",
        mayHaveCommitted: false,
      });
      expect(calls).toBe(1);
    });

    it("rejects explicitly null targets instead of creating or choosing the implicit origin", async () => {
      for (
        const command of ["loom.compose", "loom.authoring-context"] as const
      ) {
        let calls = 0;
        const result = await executeLoomAuthoringCommand(
          {
            cliPath: "/trusted/loom",
            boundLoomId: "loom-1111111111111111",
            transport: { kind: "broker", queuePath: "/trusted/queue" },
          },
          command,
          { ...(command === "loom.compose" ? input : {}), loom_id: null },
          {
            run() {
              calls++;
              return Promise.resolve({
                exitCode: 0,
                stderr: "",
                stdout: JSON.stringify(reply),
              });
            },
          },
        );
        expect(result.status).toBe("error");
        expect(calls).toBe(0);
      }
    });

    it("rejects run ids that collapse under the host's whitespace normalization", () => {
      for (const runId of ["   ", " run-one", "run-one "]) {
        expect(() =>
          validateLoomAuthoringConfig({
            cliPath: "/trusted/loom",
            transport: {
              kind: "direct",
              instanceDir: "/trusted/instance",
              runId,
              actor: "agent:cf-harness",
            },
          })
        ).toThrow();
      }
    });

    it("distinguishes verified command refusals from unreadable commit outcomes", async () => {
      for (
        const code of [
          "version-conflict",
          "request-conflict",
          "bad-args",
          "no-loom",
        ]
      ) {
        const result = await executeLoomAuthoringCommand(
          {
            cliPath: "/trusted/loom",
            transport: { kind: "broker", queuePath: "/trusted/queue" },
          },
          "loom.compose",
          input,
          {
            run: () =>
              Promise.resolve({
                exitCode: 1,
                stderr: "",
                stdout: JSON.stringify({
                  ok: false,
                  code,
                  error: "private backend detail",
                }),
              }),
          },
        );
        expect(result).toMatchObject({
          status: "error",
          code,
          mayHaveCommitted: false,
        });
      }
    });

    it("uses argv and stdin with the configured broker queue", async () => {
      const calls: ProcessRunRequest[] = [];
      const result = await executeLoomAuthoringCommand(
        {
          cliPath: "/trusted/loom",
          transport: { kind: "broker", queuePath: "/trusted/queue" },
        },
        "loom.compose",
        input,
        {
          run(request) {
            calls.push(request);
            return Promise.resolve({
              exitCode: 0,
              stdout: JSON.stringify(reply),
              stderr: "",
            });
          },
        },
      );
      expect(calls).toHaveLength(1);
      expect(calls[0].command).toBe("/trusted/loom");
      expect(calls[0].args).toEqual([
        "command",
        "run",
        "loom.compose",
        "--args-json",
        "-",
        "--json",
      ]);
      expect(JSON.parse(calls[0].stdinText!)).toEqual(input);
      expect(calls[0].clearEnv).toBe(true);
      expect(calls[0].env?.LOOM_PAGE_RPC_QUEUE).toBe("/trusted/queue");
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.result.receipt).toEqual(receipt);
        expect(result.result.replayed).toBe(true);
      }
    });

    it("pins direct calls to the configured instance, run, and agent", async () => {
      const calls: ProcessRunRequest[] = [];
      await executeLoomAuthoringCommand(
        {
          cliPath: "/trusted/loom",
          transport: {
            kind: "direct",
            instanceDir: "/trusted/instance",
            runId: "chat-session-one",
            actor: "agent:cf-harness",
          },
        },
        "loom.compose",
        input,
        {
          run(request) {
            calls.push(request);
            return Promise.resolve({
              exitCode: 0,
              stdout: JSON.stringify(reply),
              stderr: "",
            });
          },
        },
      );
      expect(calls[0].args.slice(0, 5)).toEqual([
        "command",
        "run",
        "--transport",
        "direct",
        "loom.compose",
      ]);
      expect(calls[0].env?.LOOM_INSTANCE_DIR).toBe("/trusted/instance");
      expect(calls[0].env?.LOOM_DISPATCH_ID).toBe("chat-session-one");
      expect(calls[0].args.slice(-2)).toEqual(["--actor", "agent:cf-harness"]);
    });

    it("returns uncertain failure for a mismatched or missing receipt", async () => {
      for (
        const result of [
          {},
          { ...reply.result, receipt: { ...receipt, request_id: "another" } },
          {
            ...reply.result,
            manifest: { loom_id: "loom-2222222222222222", version: 3 },
          },
        ]
      ) {
        const output = await executeLoomAuthoringCommand(
          {
            cliPath: "/trusted/loom",
            transport: { kind: "broker", queuePath: "/trusted/queue" },
          },
          "loom.compose",
          input,
          {
            run() {
              return Promise.resolve({
                exitCode: 0,
                stdout: JSON.stringify({ ok: true, result }),
                stderr: "",
              });
            },
          },
        );
        expect(output.status).toBe("error");
        if (output.status === "error") {
          expect(output.mayHaveCommitted).toBe(true);
        }
      }
    });

    it("refuses actor or transport arguments before spawning a process", async () => {
      let calls = 0;
      const output = await executeLoomAuthoringCommand(
        {
          cliPath: "/trusted/loom",
          transport: { kind: "broker", queuePath: "/trusted/queue" },
        },
        "loom.compose",
        { ...input, actor: "user" },
        {
          run() {
            calls++;
            return Promise.resolve({ exitCode: 1, stdout: "", stderr: "" });
          },
        },
      );
      expect(calls).toBe(0);
      expect(output.status).toBe("error");
    });
  });
});
