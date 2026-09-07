import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { BuiltInLLMContent, BuiltInLLMMessage } from "@commonfabric/api";
import {
  DEFAULT_MODEL_NAME,
  GOOGLE_SEARCH_NATIVE_MODEL_TOOL,
  isLLMTool,
  llmRequestProblem,
  type LLMTool,
} from "../src/types.ts";

// This carries its declared type so that renaming a field stops this file
// compiling. A guard reads fields by name, which no type check reaches, so an
// untyped fixture would go on agreeing with a guard that the type had left
// behind.
const TOOL: LLMTool = {
  description: "Look a term up",
  inputSchema: { type: "object" },
};

/** A well-formed request, with `input` written over it. */
const request = (input: object) => ({
  cache: true,
  model: DEFAULT_MODEL_NAME,
  messages: [{ role: "user", content: "Hi" }] satisfies BuiltInLLMMessage[],
  ...input,
});

describe("types", () => {
  describe("llmRequestProblem()", () => {
    // Each case that expects a refusal asserts the part of the text a caller
    // acts on -- the field named, the position of the message -- rather than
    // the whole sentence, so rewording an explanation does not break the pin.

    it("returns `undefined` for the requests it accepts", () => {
      expect(llmRequestProblem(request({}))).toBeUndefined();
      expect(llmRequestProblem(request({
        system: "System prompt",
        stop: "```\n",
        stream: false,
        mode: "json",
        maxTokens: 4096,
      }))).toBeUndefined();
      expect(llmRequestProblem(request({
        messages: [
          { role: "user", content: "Hi" },
          { role: "assistant", content: "Hello there" },
        ] satisfies BuiltInLLMMessage[],
      }))).toBeUndefined();
      expect(llmRequestProblem(request({
        metadata: { foo: "bar", id: "abcd" },
      }))).toBeUndefined();
      expect(llmRequestProblem(request({
        nativeModelToolIds: [GOOGLE_SEARCH_NATIVE_MODEL_TOOL],
      }))).toBeUndefined();
    });

    it("returns `undefined` for any metadata value JSON carries faithfully", () => {
      expect(llmRequestProblem(request({
        metadata: {
          retryCount: 1,
          enabled: true,
          nothing: null,
          nested: { deep: ["a", 2] },
          // `undefined` means "absent" -- JSON drops the key.
          absent: undefined,
        },
      }))).toBeUndefined();
    });

    it("returns text naming each required field a request leaves out", () => {
      const messages: BuiltInLLMMessage[] = [{ role: "user", content: "Hi" }];
      expect(llmRequestProblem({ messages, cache: true })).toContain("'model'");
      expect(
        llmRequestProblem({ model: DEFAULT_MODEL_NAME, cache: true }),
      ).toContain("'messages'");
      expect(
        llmRequestProblem({ model: DEFAULT_MODEL_NAME, messages }),
      ).toContain("'cache'");
    });

    it("returns text naming `messages` for an empty conversation", () => {
      // The provider refuses one whatever the `system` field carries, so the
      // guard names it here rather than letting it arrive as a failed request.
      expect(llmRequestProblem(request({ messages: [], system: "Be brief" })))
        .toContain("'messages'");
    });

    it("returns text naming the field whose value is of the wrong type", () => {
      const named = (input: object, field: string) =>
        expect(llmRequestProblem(request(input))).toContain(field);
      named({ maxTokens: "4096 " }, "'maxTokens'");
      named({ system: {} }, "'system'");
      named({ stop: {} }, "'stop'");
      named({ mode: "html" }, "'mode'");
      named({ metadata: "via piece" }, "'metadata'");
      named({ tools: [] }, "'tools'");
      named({ nativeModelToolIds: ["unknown_search"] }, "'nativeModelToolIds'");
      named(
        { nativeModelToolIds: [GOOGLE_SEARCH_NATIVE_MODEL_TOOL, 1] },
        "'nativeModelToolIds'",
      );
    });

    it("returns text naming `metadata` for a value JSON does not carry", () => {
      const refusedMetadata = (metadata: object) =>
        expect(llmRequestProblem(request({ metadata }))).toContain(
          "'metadata'",
        );
      refusedMetadata({ when: new Date() });
      refusedMetadata({ fn: () => 1 });
      refusedMetadata({ big: 1n });
      refusedMetadata({ nope: Number.NaN });
    });

    it("returns `undefined` for a message whose content carries a tool call", () => {
      const content: BuiltInLLMContent = [
        { type: "text", text: "Looking that up" },
        {
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "lookup",
          input: { term: "fabric" },
        },
      ];
      expect(
        llmRequestProblem(request({
          messages: [{
            role: "assistant",
            content,
          }] satisfies BuiltInLLMMessage[],
        })),
      ).toBeUndefined();
    });

    it("returns text naming the message whose content part is unrecognized", () => {
      expect(llmRequestProblem(request({
        messages: [{
          role: "assistant",
          content: [{ type: "tool-invocation", toolCallId: "call_1" }],
        }],
      }))).toContain("Message 0");
    });

    // A message carrying the `system` role is the case the next two are here
    // for. `BuiltInLLMMessage` leaves that role out, and the AI SDK the
    // messages reach refuses one inside `messages`, so the guard refuses it
    // here where a caller can still be told which field to move it to.

    it("returns text naming the `system` field for a system-role message", () => {
      const problem = llmRequestProblem(request({
        messages: [{ role: "system", content: "Be brief" }],
      }));
      expect(problem).toContain("Message 0");
      expect(problem).toContain("'system' field");
    });

    it("returns `undefined` for a system instruction in the `system` field", () => {
      const message: BuiltInLLMMessage = { role: "user", content: "Hi" };
      expect(
        llmRequestProblem(request({ system: "Be brief", messages: [message] })),
      ).toBeUndefined();
    });

    it("returns text naming the position of the message it refuses", () => {
      const message: BuiltInLLMMessage = { role: "user", content: "Hi" };
      const problem = llmRequestProblem(request({
        messages: [message, { role: "wizard" }],
      }));
      expect(problem).toContain("Message 1");
      expect(problem).toContain(`not "wizard"`);
    });
  });

  describe("isLLMTool()", () => {
    it("returns `true` for a description and an object schema", () => {
      expect(isLLMTool(TOOL)).toBe(true);
    });

    it("returns `false` for an `inputSchema` given as an array", () => {
      expect(isLLMTool({ ...TOOL, inputSchema: [] })).toBe(false);
    });
  });
});
