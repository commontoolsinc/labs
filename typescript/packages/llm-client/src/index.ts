export type SimpleMessage = {
  role: "user" | "assistant";
  content: SimpleContent;
}

export type SimpleContent = string | TypedContent[]

type TypedContent = {
  type: "text",
  text: string,
} | {
  type: "image",
  url: string,
}


type LLMRequest = {
  messages: SimpleMessage[] | SimpleContent[],
  system: string,
  model: string,
  max_tokens?: number,
  stream?: boolean,
  stop?: string,
}

export class LLMClient {
  private serverUrl: string;

  constructor(serverUrl: string) {
    this.serverUrl = serverUrl;
  }

  async sendRequest(userRequest: LLMRequest, partialCB?: (text: string) => void): Promise<string> {
    const fullRequest: LLMRequest = {
      ...userRequest,
      stream: partialCB ? true : false,
      messages: userRequest.messages.map(processMessage),
    }

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

    // the server might return cached data instead of a stream
    if (response.headers.get("content-type") === "application/json") {
      let data = await response.json() as SimpleMessage;
      // FIXME(ja): can the LLM ever return anything other than a string?
      return data.content as string; 
    }

    return await this.stream(response.body, partialCB);
  }

  private async stream(body: ReadableStream, cb?: (partial: string) => void): Promise<string> {
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
        while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
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

function processMessage(m: SimpleMessage | SimpleContent, idx: number): SimpleMessage {
  if (typeof m === "string" || Array.isArray(m)) {
    return {
      role: idx % 2 === 0 ? "user" : "assistant",
      content: m,
    };
  }
  return m;
}