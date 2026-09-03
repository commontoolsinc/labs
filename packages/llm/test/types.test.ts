import { describe, it } from "@std/testing/bdd";
import { assert } from "@std/assert";
import { expect } from "@std/expect";
import type { BuiltInLLMContent } from "@commonfabric/api";
import {
  DEFAULT_MODEL_NAME,
  GOOGLE_SEARCH_NATIVE_MODEL_TOOL,
  isLLMRequest,
  isLLMTool,
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

describe("types", () => {
  describe("isLLMRequest", () => {
    it("success cases", () => {
      assert(isLLMRequest({
        messages: [],
        model: DEFAULT_MODEL_NAME,
        cache: true,
      }));
      assert(isLLMRequest({
        messages: [],
        model: DEFAULT_MODEL_NAME,
        system: "System prompt",
        stop: "```\n",
        stream: false,
        mode: "json",
        maxTokens: 4096,
        cache: true,
      }));
      assert(isLLMRequest({
        messages: [{
          role: "user",
          content: "Hi",
        }, {
          role: "assistant",
          content: "Hello there",
        }],
        model: DEFAULT_MODEL_NAME,
        cache: true,
      }));
      assert(isLLMRequest({
        messages: [],
        model: DEFAULT_MODEL_NAME,
        metadata: {
          foo: "bar",
          id: "abcd",
        },
        cache: true,
      }));
      // Any JSON-faithful value is valid metadata, not just strings.
      assert(isLLMRequest({
        messages: [],
        model: DEFAULT_MODEL_NAME,
        metadata: {
          retryCount: 1,
          enabled: true,
          nothing: null,
          nested: { deep: ["a", 2] },
          // `undefined` means "absent" -- JSON drops the key.
          absent: undefined,
        },
        cache: true,
      }));
      assert(isLLMRequest({
        messages: [],
        model: DEFAULT_MODEL_NAME,
        nativeModelToolIds: [GOOGLE_SEARCH_NATIVE_MODEL_TOOL],
        cache: true,
      }));
    });
    it("fail cases", () => {
      const failRequest = (input: object) =>
        assert(
          !isLLMRequest({
            cache: true,
            model: DEFAULT_MODEL_NAME,
            messages: [],
            ...input,
          }),
        );
      assert(
        !isLLMRequest({
          model: DEFAULT_MODEL_NAME,
          cache: true,
        }),
      );
      assert(
        !isLLMRequest({
          messages: [],
          cache: true,
        }),
      );
      assert(
        !isLLMRequest({
          model: DEFAULT_MODEL_NAME,
          messages: [],
        }),
      );
      failRequest({ maxTokens: "4096 " });
      failRequest({ system: {} });
      failRequest({ stop: {} });
      failRequest({ mode: "html" });
      failRequest({ metadata: "via piece" });
      // Not carried faithfully across the JSON boundary to the model API.
      failRequest({ metadata: { when: new Date() } });
      failRequest({ metadata: { fn: () => 1 } });
      failRequest({ metadata: { big: 1n } });
      failRequest({ metadata: { nope: Number.NaN } });
      failRequest({ nativeModelToolIds: ["unknown_search"] });
      failRequest({ nativeModelToolIds: [GOOGLE_SEARCH_NATIVE_MODEL_TOOL, 1] });
    });

    it("returns `false` for a `tools` map given as an array", () => {
      expect(
        isLLMRequest({
          messages: [],
          model: DEFAULT_MODEL_NAME,
          cache: true,
          tools: [],
        }),
      ).toBe(false);
    });

    it("returns `true` for a message whose content carries a tool call", () => {
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
        isLLMRequest({
          messages: [{ role: "assistant", content }],
          model: DEFAULT_MODEL_NAME,
          cache: true,
        }),
      ).toBe(true);
    });

    it("returns `false` for a content part of an unrecognized type", () => {
      expect(
        isLLMRequest({
          messages: [{
            role: "assistant",
            content: [{ type: "tool-invocation", toolCallId: "call_1" }],
          }],
          model: DEFAULT_MODEL_NAME,
          cache: true,
        }),
      ).toBe(false);
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
