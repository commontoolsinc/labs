export type SimpleMessage = {
  role: "user" | "assistant",
  content: string,
}

type LLMRequest = {
  messages: SimpleMessage[],
  system: string,
  model: string,
  max_tokens: number,
  stream?: boolean,
}


export class LLMClient {
  private serverUrl: string;

  constructor(serverUrl: string) {
    this.serverUrl = serverUrl;
  }

  async sendRequest(userRequest: LLMRequest, partialCB?: (text: string) => void): Promise<SimpleMessage> {
    const fullRequest: LLMRequest = {
      ...userRequest,
      stream: partialCB ? true : false,
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

    // if server responds with json, just return the response
    if (response.headers.get("content-type") === "application/json") {
      return response.json() as Promise<SimpleMessage>;
    }

    let content = await this.stream(response.body, partialCB);

    return { content, role: "assistant" };
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
