import { describe, it } from "@std/testing/bdd";
import { assert, assertEquals } from "@std/assert";
import {
  DEFAULT_MODEL_NAME,
  extractTextFromLLMResponse,
  GOOGLE_SEARCH_NATIVE_MODEL_TOOL,
  isLLMRequest,
  type LLMResponse,
} from "../src/types.ts";

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
      failRequest({ nativeModelToolIds: ["unknown_search"] });
      failRequest({ nativeModelToolIds: [GOOGLE_SEARCH_NATIVE_MODEL_TOOL, 1] });
    });
  });

  describe("extractTextFromLLMResponse", () => {
    it("returns string response content", () => {
      const response: LLMResponse = {
        role: "assistant",
        content: "hello",
        id: "response-1",
      };

      assertEquals(extractTextFromLLMResponse(response), "hello");
    });

    it("joins text parts and skips other content parts", () => {
      const response: LLMResponse = {
        role: "assistant",
        content: [
          { type: "text", text: "hello" },
          { type: "image", image: "https://example.com/image.png" },
          { type: "text", text: "world" },
        ],
        id: "response-2",
      };

      assertEquals(extractTextFromLLMResponse(response), "hello world");
    });
  });
});
