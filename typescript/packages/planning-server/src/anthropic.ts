import { Anthropic } from "./deps.ts";
import { processStream } from "./stream.ts";
import { tools, toolImpls } from "./tools.ts";

const anthropic = new Anthropic({
  apiKey: Deno.env.get("ANTHROPIC_API_KEY"),
});

export const OPUS = "claude-3-5-opus-20240307";
export const HAIKU = "claude-3-haiku-20240307";
export const SONNET = "claude-3-5-sonnet-20240620";

const MAX_TOKENS = 4096;

export async function single(text: string, model: string = SONNET) {
  let response = "";
  const stream = await anthropic.messages.stream({
    max_tokens: MAX_TOKENS,
    messages: [
      {
        role: "user",
        content: text,
      },
    ],
    model,
  });

  for await (const event of stream) {
    if (event.type === "content_block_delta") {
      response += event.delta.text;
      Deno.stdout.writeSync(new TextEncoder().encode(event.delta.text));
    }
  }

  return response;
}

export async function ask(
  initialConversation: Anthropic.Messages.MessageParam[] = [],
  systemPrompt: string = "",
  activeTools: string[]
) {
  const conversation: Anthropic.Messages.MessageParam[] = [
    ...initialConversation,
  ];

  let running = true;
  while (running) {
    console.log("Conversation", conversation);
    const stream = await anthropic.messages.stream({
      max_tokens: MAX_TOKENS,
      messages: conversation,
      system: systemPrompt,
      model: SONNET,
      tools: tools.filter((tool) => activeTools.includes(tool.name)),
    });

    const { message, stopReason } = await processStream(stream);

    conversation.push({
      role: "assistant",
      content: message,
    });

    console.log("\nMessage", stopReason);
    if (
      stopReason === "stop_sequence" ||
      stopReason === "end_turn" ||
      stopReason === "max_tokens"
    ) {
      console.log("Stopping conversation", stopReason);
      running = false;
      return conversation;
    }

    if (stopReason === "tool_use") {
      const result = await processTools(message);
      conversation.push(...result);
    }

    return conversation;
  }
}

async function processTools(message: Anthropic.Messages.ContentBlock[]) {
  const outputMessage = [];
  const toolCalls = message.filter(
    (msg): msg is Anthropic.Messages.ToolUseBlock => msg.type === "tool_use"
  );
  const calls = toolCalls.map(async (tool) => {
    const input = tool.input as any;
    console.log("Tool call", tool);
    if (toolImpls[tool.name] === undefined) {
      console.error(`Tool implementation not found for ${tool.name}`);
      return [
        tool.id,
        await new Promise<string>((resolve) => resolve("")),
      ] as const;
    } else {
      return [tool.id, await toolImpls[tool.name](input)] as const;
    }
  });

  const results = await Promise.all(calls);
  let toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
  for (const [id, result] of results) {
    const toolResult: Anthropic.Messages.ToolResultBlockParam = {
      type: "tool_result",
      tool_use_id: id,
      content: [
        {
          type: "text",
          text: `${result}`,
        },
      ],
    };
    console.log("Tool result", toolResult);
    toolResults.push(toolResult);
  }

  if (toolResults.length > 0) {
    const msg: Anthropic.Messages.MessageParam = {
      role: "user",
      content: [...toolResults],
    };
    outputMessage.push(msg);
  }
  return outputMessage;
}
