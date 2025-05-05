import { describe, it } from "@std/testing/bdd";
import { assert } from "@std/assert";
import { DEFAULT_MODEL_NAME, isLLMRequest, LLMRequest } from "../src/types.ts";

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
    });
    it("fail cases", () => {
      const failRequest = (input: object) =>
        assert(!isLLMRequest({ cache: true, model: DEFAULT_MODEL_NAME, messages: [], ...input }));
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
      failRequest({ metadata: "via charm" });
    });
  });
});
