/**
 * `call_verb` sends an event to a verb of a piece the run holds, and
 * `describe_handle` is where the run learns which verbs that piece has and
 * what each takes and returns. Together they are what lets an agent drive a
 * piece it was handed rather than only read it.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import { type Cell, Runtime } from "@commonfabric/runner";
import { parseLLMFriendlyLink } from "@commonfabric/runner/shared";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import type { HarnessFabricSessionConfig } from "../src/config.ts";
import { createToolOutputId } from "../src/contracts/tool-result.ts";
import type {
  HarnessAssistantTranscriptMessage,
  HarnessToolTranscriptMessage,
} from "../src/contracts/transcript.ts";
import type { HarnessFabricSession } from "../src/fabric-session.ts";
import {
  createHarnessHandleTable,
  mintAddressHandle,
  resolveHandleToken,
} from "../src/handle-table.ts";
import type { HarnessModelTurnRequest } from "../src/model/client.ts";
import { CfHarnessPromptLoop } from "../src/prompt-loop.ts";
import type { SandboxRuntime } from "../src/sandbox/types.ts";
import { callVerbTool } from "../src/tools/call-verb.ts";
import { describeHandleTool } from "../src/tools/describe-handle.ts";
import {
  runPatternTool,
  type RunPatternToolSuccessOutput,
} from "../src/tools/run-pattern.ts";
import type { HarnessToolContext } from "../src/tools/types.ts";
import { directPromptSlotBindingFor } from "./support/prompt-slot-binding.ts";

const signer = await Identity.fromPassphrase("cf-harness call-verb");

/**
 * A timer whose state changes only through its verbs. `start` takes fields
 * and hands back a result, `stop` takes nothing, and `status` is data rather
 * than a verb, which is what the refusals below need to tell apart.
 */
const TIMER_PATTERN_SOURCE = [
  "import { action, computed, Default, NAME, pattern, Stream, Writable } from 'commonfabric';",
  "interface StartEvent {",
  "  /** How long the timer runs, in whole minutes. */",
  "  minutes: number;",
  "  label?: string;",
  "}",
  "interface StartResult { endsAt: number; label: string; }",
  "interface Input {",
  "  minutes?: Writable<number | Default<25>>;",
  "  label?: Writable<string | Default<''>>;",
  "  status?: Writable<string | Default<'idle'>>;",
  "}",
  "interface Output {",
  "  $NAME: string;",
  "  minutes: number;",
  "  label: string;",
  "  status: string;",
  "  /** Start the timer. */",
  "  start: Stream<StartEvent, StartResult>;",
  "  stop: Stream<void>;",
  "}",
  "export default pattern<Input, Output>(({ minutes, label, status }) => {",
  "  const start = action<StartEvent, StartResult>((event) => {",
  "    minutes.set(event.minutes);",
  "    label.set(event.label ?? '');",
  "    status.set('running');",
  "    return { endsAt: event.minutes * 60000, label: event.label ?? '' };",
  "  });",
  "  const stop = action(() => { status.set('stopped'); });",
  "  return {",
  "    [NAME]: computed(() => `Timer: ${status.get()}`),",
  "    minutes, label, status, start, stop,",
  "  };",
  "});",
  "",
].join("\n");

/** The context members the two tools read, and no others. */
const contextWith = (
  session: HarnessFabricSession,
  table?: ReturnType<typeof createHarnessHandleTable>,
): HarnessToolContext =>
  ({
    runId: "run-call-verb",
    cfcEnforcementMode: "disabled",
    ...(table !== undefined ? { handleTable: table } : {}),
    getFabricSession: () => Promise.resolve(session),
    nextOutputId: (toolId: string) =>
      createToolOutputId("run-call-verb", toolId, 1),
  }) as unknown as HarnessToolContext;

describe("call-verb", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let session: HarnessFabricSession;
  let neighbour: PiecesController;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
    const pieces = new PiecesController(
      createSession({
        identity: signer,
        spaceDid: (await Identity.generate()).did(),
      }),
      runtime,
    );
    await pieces.synced();
    session = { pieces };
    neighbour = new PiecesController(
      createSession({
        identity: signer,
        spaceDid: (await Identity.generate()).did(),
      }),
      runtime,
    );
    await neighbour.synced();
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  /** Runs the timer and returns the reference to its result cell. */
  const createTimer = async (): Promise<string> => {
    const output = await runPatternTool.invoke(
      contextWith(session),
      { sourceText: TIMER_PATTERN_SOURCE },
    ) as RunPatternToolSuccessOutput;
    expect(output.status).toBe("ok");
    return output.resultRef;
  };

  /** One field of the piece at `ref`, read back through the runtime. */
  const readField = async (ref: string, field: string): Promise<unknown> => {
    const cell = runtime.getCellFromLink(
      parseLLMFriendlyLink(ref, session.pieces.getSpace()),
    ) as Cell<Record<string, unknown>>;
    return await cell.key(field).pull();
  };

  describe("describe_handle on a piece", () => {
    it("lists each verb with the event it takes and the result it returns", async () => {
      // The listing is the call signature: without the event's fields an
      // agent cannot write a call, and without the result it cannot plan on
      // what comes back. `status` is data and is not listed.
      const ref = await createTimer();
      const minted = await mintAddressHandle(
        createHarnessHandleTable("run-call-verb"),
        ref,
      );

      const output = await describeHandleTool.invoke(
        contextWith(session, minted.table),
        { token: minted.token },
      );

      expect(output.verbs?.map((verb) => verb.name)).toEqual([
        "start",
        "stop",
      ]);
      const start = output.verbs!.find((verb) => verb.name === "start")!;
      expect(start.inputSchema).toEqual({
        type: "object",
        properties: {
          minutes: { type: "number" },
          label: { type: "string" },
        },
        required: ["minutes"],
      });
      expect(start.outputSchema).toEqual({
        type: "object",
        properties: {
          endsAt: { type: "number" },
          label: { type: "string" },
        },
        required: ["endsAt", "label"],
      });
    });

    it("reports no prose from the pattern's doc comments on a verb", async () => {
      // A verb's signature is reduced to structure like every other schema
      // this tool discloses, so the author's words do not ride out on it.
      const ref = await createTimer();
      const minted = await mintAddressHandle(
        createHarnessHandleTable("run-call-verb"),
        ref,
      );

      const output = await describeHandleTool.invoke(
        contextWith(session, minted.table),
        { token: minted.token },
      );

      const text = JSON.stringify(output.verbs);
      expect(text).not.toContain("whole minutes");
      expect(text).not.toContain("Start the timer");
    });

    it("lists no verbs for a field within a piece", async () => {
      const ref = await createTimer();
      const minted = await mintAddressHandle(
        createHarnessHandleTable("run-call-verb"),
        `${ref}/status`,
      );

      const output = await describeHandleTool.invoke(
        contextWith(session, minted.table),
        { token: minted.token },
      );

      expect(output.verbs).toBeUndefined();
    });
  });

  describe("call_verb", () => {
    it("runs the verb's handler and returns its declared result", async () => {
      const ref = await createTimer();

      const output = await callVerbTool.invoke(contextWith(session), {
        token: ref,
        verb: "start",
        event: { minutes: 10 },
      });

      expect(output).toMatchObject({
        status: "ok",
        verb: "start",
        result: { endsAt: 600000 },
      });
      expect(await readField(ref, "status")).toBe("running");
      expect(await readField(ref, "minutes")).toBe(10);
    });

    it("returns a string the result carries as a reference rather than as text", async () => {
      // A string is free text, which the release boundary withholds unless a
      // schema bounds it; the reference addresses the position instead, so a
      // later step can still wire it onward.
      const ref = await createTimer();

      const output = await callVerbTool.invoke(contextWith(session), {
        token: ref,
        verb: "start",
        event: { minutes: 10, label: "deep work" },
      });

      expect(output.status).toBe("ok");
      expect(JSON.stringify(output)).not.toContain("deep work");
      const result = (output as { result: { label: unknown } }).result;
      expect(result.label).toEqual({ "@link": expect.any(String) });
    });

    it("runs a verb that takes no event", async () => {
      const ref = await createTimer();

      const output = await callVerbTool.invoke(contextWith(session), {
        token: ref,
        verb: "stop",
      });

      expect(output).toMatchObject({ status: "ok", verb: "stop" });
      expect(await readField(ref, "status")).toBe("stopped");
    });

    it("refuses a field the verb does not declare, before the event is sent", async () => {
      // `minutes` alone would start the timer, so a status still `idle`
      // afterwards is what shows nothing was dispatched.
      const ref = await createTimer();

      const output = await callVerbTool.invoke(contextWith(session), {
        token: ref,
        verb: "start",
        event: { minutes: 10, colour: "red" },
      });

      expect(output.status).toBe("error");
      expect((output as { message: string }).message).toContain('"colour"');
      expect(await readField(ref, "status")).toBe("idle");
      expect(await readField(ref, "minutes")).toBe(25);
    });

    it("refuses an event missing a required field, before the event is sent", async () => {
      const ref = await createTimer();

      const output = await callVerbTool.invoke(contextWith(session), {
        token: ref,
        verb: "start",
        event: { label: "deep work" },
      });

      expect(output.status).toBe("error");
      expect((output as { message: string }).message).toContain("minutes");
      expect(await readField(ref, "status")).toBe("idle");
    });

    it("refuses a property that is not a verb and names the verbs there are", async () => {
      const ref = await createTimer();

      const output = await callVerbTool.invoke(contextWith(session), {
        token: ref,
        verb: "status",
        event: "running",
      });

      expect(output.status).toBe("error");
      const message = (output as { message: string }).message;
      expect(message).toContain('"status" is not a verb');
      expect(message).toContain('"start"');
      expect(message).toContain('"stop"');
      expect(await readField(ref, "status")).toBe("idle");
    });

    it("refuses a piece in a space other than the run's own", async () => {
      // The run may describe a piece in an admitted foreign space, which is a
      // read; sending it an event is a write, which reaches the run's own
      // space only.
      const foreign = await neighbour.create(TIMER_PATTERN_SOURCE, {
        input: {},
      });
      const ref =
        `//${neighbour.getSpace()}/${foreign.getCell().getAsNormalizedFullLink().id}`;

      const output = await callVerbTool.invoke(contextWith(session), {
        token: ref,
        verb: "start",
        event: { minutes: 10 },
      });

      expect(output.status).toBe("error");
      expect((output as { message: string }).message).toContain(
        "this run's own space",
      );
    });
  });

  describe("at the prompt-loop model boundary", () => {
    it("lets a model holding a piece's handle read its verbs and call one", async () => {
      // The model never sees an address: it holds the token run_pattern
      // handed back, describes it to learn the verbs, and calls one by the
      // same token.
      const artifactRoot = await Deno.makeTempDir();
      const fabricSession: HarnessFabricSessionConfig = {
        apiUrl: "http://toolshed.test",
        identityKeyPath: "/unused/fixture.key",
        space: session.pieces.getSpace(),
      };
      const requests: HarnessModelTurnRequest[] = [];
      const lastToolOutput = (request: HarnessModelTurnRequest) =>
        JSON.parse(
          (request.transcript.findLast((message) => message.role === "tool") as
            | HarnessToolTranscriptMessage
            | undefined)!.content,
        );
      const toolCall = (
        name: string,
        input: unknown,
      ): HarnessAssistantTranscriptMessage => ({
        role: "assistant",
        content: "",
        toolCalls: [{
          id: `call-${name}`,
          type: "function",
          function: { name, arguments: JSON.stringify(input) },
        }],
      });
      let token = "";
      try {
        const loop = new CfHarnessPromptLoop({
          sandboxRuntime: {
            describe: () => ({
              kind: "runsc-cfc",
              defaultWorkingDirectory: "/workspace",
              cfc: { runtimeRequested: true, workspaceMountPath: "/workspace" },
            }),
            defaultWorkingDirectory: () => "/workspace",
            resolvePath: (path) => path,
            isPathWithinWorkspace: () => true,
            isPathWithinAllowedRoots: () => true,
            run: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
            runShell: () =>
              Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
          } satisfies SandboxRuntime,
          artifactRoot,
          runId: "run-call-verb-loop",
          model: "test-model",
          fabricSession,
          fabricSessionFactory: () => Promise.resolve(session),
          allowedToolIds: ["run_pattern", "describe_handle", "call_verb"],
          modelClient: {
            providerId: "test-provider",
            complete: (request) => {
              requests.push({
                ...request,
                transcript: [...request.transcript],
              });
              switch (requests.length) {
                case 1:
                  return Promise.resolve({
                    assistant: toolCall("run_pattern", {
                      sourceText: TIMER_PATTERN_SOURCE,
                    }),
                  });
                case 2:
                  token = lastToolOutput(request).resultRef;
                  return Promise.resolve({
                    assistant: toolCall("describe_handle", { token }),
                  });
                case 3:
                  return Promise.resolve({
                    assistant: toolCall("call_verb", {
                      token,
                      verb: "start",
                      event: { minutes: 10 },
                    }),
                  });
                default:
                  return Promise.resolve({
                    assistant: { role: "assistant", content: "Started." },
                  });
              }
            },
          },
        });

        const result = await loop.runPrompt({
          prompt: "start a ten minute timer",
          maxModelTurns: 4,
          promptSlotBinding: directPromptSlotBindingFor("call-verb"),
        });

        expect(token).toMatch(/^cfh:a:/);
        const described = lastToolOutput(requests[2]);
        expect(described.verbs.map((verb: { name: string }) => verb.name))
          .toEqual(["start", "stop"]);
        const called = lastToolOutput(requests[3]);
        expect(called).toMatchObject({
          status: "ok",
          verb: "start",
          result: { endsAt: 600000 },
        });
        const entry = resolveHandleToken(result.runState.handleTable!, token);
        expect(await readField(entry!.ref, "status")).toBe("running");
      } finally {
        await Deno.remove(artifactRoot, { recursive: true });
      }
    });
  });
});
