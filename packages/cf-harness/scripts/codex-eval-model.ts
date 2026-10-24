/**
 * The model a hand-run eval asks: the Codex research model on the owner's
 * credential from a harness home, one turn at a time, offered the tools the
 * eval declares.
 */
import {
  defaultHarnessCredentialStorePath,
  FileHarnessCredentialStore,
} from "../src/auth/credential-store.ts";
import { OpenAICodexCredentialResolver } from "../src/auth/openai-codex.ts";
import type { HarnessModelToolDescriptor } from "../src/contracts/tool-descriptor.ts";
import type { HarnessAssistantTranscriptMessage } from "../src/contracts/transcript.ts";
import { OpenAICodexResponsesClient } from "../src/model/openai-codex-responses.ts";
import { researchModel } from "../src/research/runner.ts";

/** A model offered tools: its name and one turn, the reply as it came back. */
export interface EvalToolModel {
  name: string;
  turn: (
    prompt: string,
    tools: readonly HarnessModelToolDescriptor[],
  ) => Promise<HarnessAssistantTranscriptMessage>;
}

/** The Codex research model on the owner's credential, offered tools. */
export const codexEvalToolModel = (
  harnessHome: string,
  ownerKey: string,
  runId: string,
): EvalToolModel => {
  const credentialOwner = {
    type: "cf-harness.credential-owner-ref",
    version: 1,
    ownerKey,
  } as const;
  const client = new OpenAICodexResponsesClient({
    credentialResolver: new OpenAICodexCredentialResolver({
      store: new FileHarnessCredentialStore({
        path: defaultHarnessCredentialStorePath(harnessHome),
      }),
      ownerKey,
      credentialOwner,
    }),
    credentialOwner,
  });
  const model = researchModel(client.providerId);
  return {
    name: model,
    turn: async (prompt, tools) =>
      (await client.complete({
        model,
        transcript: [{ role: "user", content: prompt }],
        tools,
        nativeModelToolIds: [],
        runId,
      })).assistant,
  };
};
