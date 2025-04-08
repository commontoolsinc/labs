import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import env from "@/env.ts";
import { cleanJsonResponse, configureJsonMode } from "./generateText.ts";

if (env.ENV !== "test") {
  throw new Error("ENV must be 'test'");
}

describe("configureJsonMode", () => {
  it("configures JSON mode correctly for Groq models", () => {
    const streamParams: Record<string, any> = {};
    const messages = [{
      role: "user" as const,
      content: "Generate a JSON response",
    }];

    configureJsonMode(streamParams, "groq:llama-3.3-70b", messages, false);

    assertEquals(streamParams.mode, undefined);
    assertEquals(streamParams.response_format, { type: "json_object" });
    assertEquals(streamParams.providerOptions?.groq?.response_format, {
      type: "json_object",
    });
    assertEquals(typeof streamParams.system, "string");
    assertEquals(
      streamParams.system.includes("respond with pure, correct JSON only"),
      true,
    );
  });

  it("configures JSON mode correctly for OpenAI models", () => {
    const streamParams: Record<string, any> = {};
    const messages = [{
      role: "user" as const,
      content: "Generate a JSON response",
    }];

    configureJsonMode(streamParams, "openai:gpt-4o", messages, false);

    assertEquals(streamParams.mode, undefined);
    assertEquals(streamParams.response_format, { type: "json_object" });
    assertEquals(streamParams.providerOptions?.openai?.response_format, {
      type: "json_object",
    });
  });

  it("configures JSON mode correctly for Anthropic models", () => {
    const streamParams: Record<string, any> = {};
    const messages = [{
      role: "user" as const,
      content: "Generate a JSON response",
    }];

    configureJsonMode(
      streamParams,
      "anthropic:claude-3-7-sonnet",
      messages,
      false,
    );

    assertEquals(streamParams.mode, "json");
    assertEquals(
      streamParams.system.includes("JSON generation assistant"),
      true,
    );
    assertEquals(streamParams.prefill?.text, "{\n");
  });

  it("preserves existing system prompt while adding JSON instructions", () => {
    const streamParams: Record<string, any> = {
      system: "You are an expert assistant.",
    };
    const messages = [{
      role: "user" as const,
      content: "Generate a JSON response",
    }];

    configureJsonMode(
      streamParams,
      "anthropic:claude-3-7-sonnet",
      messages,
      false,
    );

    assertEquals(
      streamParams.system.includes(
        "You are a JSON generation assistant. You are an expert assistant.",
      ),
      true,
    );
    assertEquals(
      streamParams.system.includes("response must be ONLY valid JSON"),
      true,
    );
  });

  it("configures JSON mode correctly for other providers", () => {
    const streamParams: Record<string, any> = {};
    const messages = [{
      role: "user" as const,
      content: "Generate a JSON response",
    }];

    configureJsonMode(streamParams, "other:model", messages, false);

    assertEquals(streamParams.mode, "json");
    assertEquals(
      streamParams.system.includes("Ensure the response is valid JSON"),
      true,
    );
  });

  it("adds JSON instructions to existing system prompt for other providers", () => {
    const streamParams: Record<string, any> = {
      system: "You are an expert assistant.",
    };
    const messages = [{
      role: "user" as const,
      content: "Generate a JSON response",
    }];

    configureJsonMode(streamParams, "other:model", messages, false);

    assertEquals(
      streamParams.system,
      "You are an expert assistant.\nEnsure the response is valid JSON. DO NOT include any other text or formatting.",
    );
  });

  it("always adds JSON instructions even when system prompt already mentions JSON", () => {
    const streamParams: Record<string, any> = {
      system: "You are an expert assistant who responds in JSON format.",
    };
    const messages = [{
      role: "user" as const,
      content: "Generate a JSON response",
    }];

    configureJsonMode(streamParams, "other:model", messages, false);

    // Should always add our JSON instructions
    assertEquals(
      streamParams.system,
      "You are an expert assistant who responds in JSON format.\nEnsure the response is valid JSON. DO NOT include any other text or formatting.",
    );
  });
});

describe("cleanJsonResponse", () => {
  it("extracts JSON from markdown code blocks", () => {
    const input = '```json\n{"name": "Test", "value": 123}\n```';
    const expected = '{"name": "Test", "value": 123}';
    assertEquals(cleanJsonResponse(input), expected);
  });

  it("extracts JSON from code blocks without language specifier", () => {
    const input = '```\n{"name": "Test", "value": 123}\n```';
    const expected = '{"name": "Test", "value": 123}';
    assertEquals(cleanJsonResponse(input), expected);
  });

  it("handles multiline JSON in code blocks", () => {
    const input = '```json\n{\n  "name": "Test",\n  "value": 123\n}\n```';
    const expected = '{\n  "name": "Test",\n  "value": 123\n}';
    assertEquals(cleanJsonResponse(input), expected);
  });

  it("returns original text if no code blocks found", () => {
    const input = '{"name": "Test", "value": 123}';
    assertEquals(cleanJsonResponse(input), input);
  });

  it("returns original text if code block format is incorrect", () => {
    const input = '```json {"name": "Test", "value": 123}```';
    assertEquals(cleanJsonResponse(input), input);
  });
});
