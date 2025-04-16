import { LlmPrompt } from "./prompts/prompting.ts";
import { setLastTraceSpanID } from "@commontools/builder";

export type SimpleMessage = {
  role: "user" | "assistant";
  content: SimpleContent;
};

export type SimpleContent = string | TypedContent[];

type TypedContent =
  | {
    type: "text";
    text: string;
  }
  | {
    type: "image";
    url: string;
  };

export const DEFAULT_LLM_URL = typeof globalThis.location !== "undefined"
  ? globalThis.location.protocol + "//" + globalThis.location.host +
    "/api/ai/llm"
  : "//api/ai/llm";

export type LLMRequest = {
  messages: SimpleMessage[] | SimpleContent[];
  system?: string;
  model: string | string[];
  max_tokens?: number;
  stream?: boolean;
  stop?: string;
  mode?: "json";
  metadata?: Record<string, string | undefined | LlmPrompt>;
};

export class LLMClient {
  private serverUrl: string = DEFAULT_LLM_URL;

  public setServerUrl(toolshedUrl: string) {
    this.serverUrl = new URL("/api/ai/llm", toolshedUrl).toString();
  }

  async sendRequest(
    userRequest: LLMRequest,
    partialCB?: (text: string) => void,
  ): Promise<string> {
    const models = Array.isArray(userRequest.model)
      ? userRequest.model
      : [userRequest.model];

    const errors: Error[] = [];

    for (const model of models) {
      const fullRequest: LLMRequest = {
        ...userRequest,
        model,
        stream: partialCB ? true : false,
        messages: userRequest.messages.map(processMessage),
      };

      try {
        const response = await fetch(this.serverUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(fullRequest),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(
            `HTTP error! status: ${response.status}, body: ${errorText}`,
          );
        }

        if (!response.body) {
          throw new Error("No response body");
        }

        const traceSpanID = response.headers.get("x-ct-llm-trace-id") as string;
        if (traceSpanID) {
          setLastTraceSpanID(traceSpanID);
        }

        // the server might return cached data instead of a stream
        if (response.headers.get("content-type") === "application/json") {
          const data = (await response.json()) as SimpleMessage;
          // FIXME(ja): can the LLM ever return anything other than a string?
          return data.content as string;
        }
        // FIXME(ja): this doesn't handle falling back to other models
        // if we fail during streaming
        return await this.stream(response.body, partialCB);
      } catch (error) {
        console.error(`Model "${model}" failed:`, error, fullRequest);
        errors.push(error as Error);
      }
    }

    throw new Error("All models failed");
  }

  private async stream(
    body: ReadableStream,
    cb?: (partial: string) => void,
  ): Promise<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();

    let doneReading = false;
    let buffer = "";
    let text = "";

    while (!doneReading) {
      const { value, done } = await reader.read();
      doneReading = done;
      if (value) {
        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;

        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);

          if (line) {
            try {
              const t = JSON.parse(line);
              text += t;
              if (cb) cb(text);
            } catch (error) {
              console.error("Failed to parse JSON line:", line, error);
            }
          }
        }
      }
    }

    // Handle any remaining buffer
    if (buffer.trim()) {
      try {
        const t = JSON.parse(buffer.trim());
        text += t;
        if (cb) cb(text);
      } catch (error) {
        console.error("Failed to parse final JSON line:", buffer, error);
      }
    }

    return text;
  }
}

function processMessage(
  m: SimpleMessage | SimpleContent,
  idx: number,
): SimpleMessage {
  if (typeof m === "string" || Array.isArray(m)) {
    return {
      role: idx % 2 === 0 ? "user" : "assistant",
      content: m,
    };
  }
  return m;
}

export const client = new LLMClient();
