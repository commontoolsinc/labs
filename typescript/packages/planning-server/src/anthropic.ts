import { Anthropic } from "./deps.ts";
import { processStream } from "./stream.ts";
import { toolImpls } from "./tools.ts";
import { serverTools, ToolImpls, processTools } from "./tools.ts";

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
  activeTools: Anthropic.Messages.Tool[],
) {
  const conversation: Anthropic.Messages.MessageParam[] = [
    ...initialConversation,
  ];

  let running = true;
  while (running) {
    // console.log("Conversation", conversation);
    // console.log("activeTools", activeTools);
    const stream = await anthropic.messages.stream({
      max_tokens: MAX_TOKENS,
      messages: conversation,
      system: systemPrompt,
      model: SONNET,
      tools: [...activeTools, ...serverTools],
    });

    const { message, stopReason } = await processStream(stream);

    conversation.push({
      role: "assistant",
      content: message,
    });

    // console.log("\nMessage", stopReason);
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
      const toolCalls = message.filter(
        (msg): msg is Anthropic.Messages.ToolUseBlock =>
          msg.type === "tool_use",
      );

      // split out the tool calls that are for the client from those for the server
      const [clientToolCalls, serverToolCalls] = toolCalls.reduce(
        (acc, toolCall) => {
          if (activeTools.find((tool) => tool.name === toolCall.name)) {
            acc[0].push(toolCall);
          } else {
            acc[1].push(toolCall);
          }
          return acc;
        },
        [[], []] as [
          Anthropic.Messages.ToolUseBlock[],
          Anthropic.Messages.ToolUseBlock[],
        ],
      );

      console.log("Server tools", serverToolCalls);
      const result = await processTools(message, toolImpls, serverToolCalls);
      if (result) {
        conversation.push(result);
      }

      if (clientToolCalls.length > 0) {
        console.log("Client tools", clientToolCalls);
        return conversation;
      }

      console.log("Continuing conversation");
    }
  }
  return conversation;
}
