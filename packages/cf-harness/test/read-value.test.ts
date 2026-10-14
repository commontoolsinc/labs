/**
 * `read_value` returns the value behind a handle the run holds, once the run
 * has described it: through the release check every value bound for the model
 * passes, with what it read joining the run's model context.
 */

import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";
import { Runtime } from "@commonfabric/runner";
import { createLLMFriendlyLink } from "@commonfabric/runner/shared";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "../../runner/test/cfc-seed-envelope.ts";
import type { HarnessHandleTable } from "../src/contracts/handle-table.ts";
import { createToolOutputId } from "../src/contracts/tool-result.ts";
import type { HarnessAssistantTranscriptMessage } from "../src/contracts/transcript.ts";
import type { HarnessFabricSession } from "../src/fabric-session.ts";
import {
  createHarnessHandleTable,
  markHandleDescribed,
  mintAddressHandle,
  resolveHandleToken,
} from "../src/handle-table.ts";
import { CfHarnessPromptLoop } from "../src/prompt-loop.ts";
import type { SandboxRuntime } from "../src/sandbox/types.ts";
import { readValueTool } from "../src/tools/read-value.ts";
import type { HarnessToolContext } from "../src/tools/types.ts";
import { directPromptSlotBindingFor } from "./support/prompt-slot-binding.ts";

const signer = await Identity.fromPassphrase("cf-harness read-value");

/** The label the seeded document's `secret` field carries. */
const SECRET_ATOM = "read-value-test-secret";

/** A fabric under `mode`, with persisted flow labels. */
const createFabric = async (
  mode: "observe" | "enforce-strict",
): Promise<{
  runtime: Runtime;
  storage: ReturnType<typeof StorageManager.emulate>;
  session: HarnessFabricSession;
}> => {
  const storage = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("http://toolshed.test"),
    storageManager: storage,
    cfcEnforcementMode: mode,
    cfcFlowLabels: "persist",
  });
  const pieces = new PiecesController(
    createSession({
      identity: signer,
      spaceDid: (await Identity.generate()).did(),
    }),
    runtime,
  );
  await pieces.synced();
  return { runtime, storage, session: { pieces } };
};

/**
 * Seeds a document holding unlabelled lanes and a count, a `secret` labelled
 * {@link SECRET_ATOM}, and a link to a second document; returns its address.
 */
const seedDocument = async (
  runtime: Runtime,
  session: HarnessFabricSession,
): Promise<{ ref: string; otherRef: string }> => {
  const space = session.pieces.getSpace();
  const seed = runtime.edit();
  const other = runtime.getCell(space, "read-value-other", undefined, seed);
  other.set({ title: "Review" });
  const cell = runtime.getCell(space, "read-value-source", undefined, seed);
  const id = cell.getAsNormalizedFullLink().id;
  const otherId = other.getAsNormalizedFullLink().id;
  writeSeedEnvelopeDoc(seed, space);
  seedStoredEnvelope(seed, { space, scope: "space", id, path: [] }, {
    value: {
      lanes: ["kick", "snare"],
      count: 3,
      secret: "the vault code is 4417",
      item: { "/": { "link@1": { id: otherId, path: [] } } },
    },
    cfc: {
      version: 1,
      schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
      labelMap: {
        version: 1,
        entries: [{
          path: ["secret"],
          label: { confidentiality: [SECRET_ATOM] },
        }],
      },
    },
  });
  expect((await seed.commit().settled).ok).toBeDefined();
  return {
    ref: createLLMFriendlyLink(cell.getAsNormalizedFullLink(), space),
    otherRef: createLLMFriendlyLink(other.getAsNormalizedFullLink(), space),
  };
};

/** The context members `read_value` reads. */
const contextWith = (
  session: HarnessFabricSession,
  table: HarnessHandleTable,
): HarnessToolContext =>
  ({
    runId: "run-read-value",
    cfcEnforcementMode: "observe",
    handleTable: table,
    getFabricSession: () => Promise.resolve(session),
    nextOutputId: (toolId: string) =>
      createToolOutputId("run-read-value", toolId, 1),
  }) as unknown as HarnessToolContext;

/** `ref` held, and described unless `described` is false. */
const held = async (
  ref: string,
  described = true,
): Promise<{ table: HarnessHandleTable; token: string }> => {
  const minted = await mintAddressHandle(
    createHarnessHandleTable("run-read-value"),
    ref,
  );
  return {
    table: described
      ? markHandleDescribed(minted.table, minted.token)
      : minted.table,
    token: minted.token,
  };
};

describe("read-value", () => {
  let fabric: Awaited<ReturnType<typeof createFabric>> | undefined;

  afterEach(async () => {
    await fabric?.runtime.dispose();
    await fabric?.storage.close();
    fabric = undefined;
  });

  describe("readValueTool", () => {
    it("returns the value behind a described handle, strings as text", async () => {
      fabric = await createFabric("observe");
      const { ref } = await seedDocument(fabric.runtime, fabric.session);
      const { table, token } = await held(`${ref}/lanes`);

      const output = await readValueTool.invoke(
        contextWith(fabric.session, table),
        { token: `${ref}/lanes` },
      );

      expect(output).toMatchObject({
        status: "ok",
        token,
        value: ["kick", "snare"],
      });
    });

    it("refuses a handle the run has not described", async () => {
      // Reading is the expensive, tainting step, so it follows a look at the
      // shape rather than replacing it.
      fabric = await createFabric("observe");
      const { ref } = await seedDocument(fabric.runtime, fabric.session);
      const { table } = await held(ref, false);

      const output = await readValueTool.invoke(
        contextWith(fabric.session, table),
        { token: ref },
      );

      expect(output.status).toBe("error");
      expect((output as { message: string }).message).toContain(
        "describe_handle",
      );
    });

    it("narrows what it reads to the selected path", async () => {
      fabric = await createFabric("observe");
      const { ref } = await seedDocument(fabric.runtime, fabric.session);
      const { table } = await held(ref);

      const output = await readValueTool.invoke(
        contextWith(fabric.session, table),
        { token: ref, select: "lanes/1" },
      );

      expect(output).toMatchObject({ status: "ok", value: "snare" });
    });

    it("returns a link the value holds as an address rather than a copy", async () => {
      fabric = await createFabric("observe");
      const { ref, otherRef } = await seedDocument(
        fabric.runtime,
        fabric.session,
      );
      const { table } = await held(ref);

      const output = await readValueTool.invoke(
        contextWith(fabric.session, table),
        { token: ref },
      );

      expect(output).toMatchObject({
        status: "ok",
        value: { item: { "@link": otherRef } },
      });
    });

    it("reads through a link at the selected position to the value it names", async () => {
      // A piece's fields are links to the cells that hold them, so reading a
      // field reads what the link names rather than the link.
      fabric = await createFabric("observe");
      const { ref } = await seedDocument(fabric.runtime, fabric.session);
      const { table } = await held(ref);

      const output = await readValueTool.invoke(
        contextWith(fabric.session, table),
        { token: ref, select: "item" },
      );

      expect(output).toMatchObject({
        status: "ok",
        value: { title: "Review" },
      });
    });

    it("refuses at the root a value the model may not observe, naming why and the subagent route", async () => {
      fabric = await createFabric("enforce-strict");
      const { ref } = await seedDocument(fabric.runtime, fabric.session);
      const { table } = await held(ref);

      const output = await readValueTool.invoke(
        contextWith(fabric.session, table),
        { token: ref, select: "secret" },
      );

      expect(output.status).toBe("error");
      const message = (output as { message: string }).message;
      expect(message).toContain(SECRET_ATOM);
      expect(message).toContain("delegate_task");
      expect(JSON.stringify(output)).not.toContain("4417");
    });

    it("reports the label of what it read, where the run's posture releases it", async () => {
      fabric = await createFabric("observe");
      const { ref } = await seedDocument(fabric.runtime, fabric.session);
      const { table } = await held(ref);

      const output = await readValueTool.invoke(
        contextWith(fabric.session, table),
        { token: ref, select: "secret" },
      );

      expect(output).toMatchObject({
        status: "ok",
        value: "the vault code is 4417",
      });
      expect(
        JSON.stringify(
          (output as { cfc?: { observedLabel?: unknown } }).cfc?.observedLabel,
        ),
      ).toContain(SECRET_ATOM);
    });
  });

  describe("at the prompt-loop model boundary", () => {
    it("marks a handle described once described, and taints the run with what it reads", async () => {
      // A scripted model describes the handle, then reads it: the describe is
      // what admits the read, and the read's label joins the model context.
      fabric = await createFabric("observe");
      const { ref } = await seedDocument(fabric.runtime, fabric.session);
      const minted = await mintAddressHandle(
        createHarnessHandleTable("run-read-value-loop"),
        ref,
      );
      const call = (
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
      const steps = [
        call("describe_handle", { token: minted.token }),
        call("read_value", { token: minted.token, select: "secret" }),
      ];
      let turn = 0;
      const artifactRoot = await Deno.makeTempDir();
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
          runId: "run-read-value-loop",
          model: "test-model",
          cfcEnforcementMode: "observe",
          inheritedHandleTable: minted.table,
          fabricSession: {
            apiUrl: "http://toolshed.test",
            identityKeyPath: "/unused/fixture.key",
            space: fabric.session.pieces.getSpace(),
          },
          fabricSessionFactory: () => Promise.resolve(fabric!.session),
          allowedToolIds: ["describe_handle", "read_value"],
          modelClient: {
            providerId: "test-provider",
            complete: () => {
              const assistant = steps[turn] ??
                { role: "assistant" as const, content: "Done." };
              turn += 1;
              return Promise.resolve({ assistant });
            },
          },
        });

        const result = await loop.runPrompt({
          prompt: "read the secret",
          maxModelTurns: 3,
          promptSlotBinding: directPromptSlotBindingFor("read-value"),
        });

        const table = result.runState.handleTable!;
        expect(resolveHandleToken(table, minted.token)?.described).toBe(true);
        expect(JSON.stringify(result.runState.cfcModelContext?.label))
          .toContain(SECRET_ATOM);
      } finally {
        await Deno.remove(artifactRoot, { recursive: true });
      }
    });
  });
});
