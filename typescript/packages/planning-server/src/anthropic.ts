import { Anthropic } from "./deps.ts";
import { tools, toolImpls } from "./tools.ts";

const anthropic = new Anthropic({
  apiKey: Deno.env.get("ANTHROPIC_API_KEY"),
});

const OPUS = "claude-3-5-opus-20240307";
const HAIKU = "claude-3-haiku-20240307";
const SONNET = "claude-3-5-sonnet-20240620";

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
  let conversation: Anthropic.Messages.MessageParam[] = [
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

    const currentMessage: Anthropic.Messages.ContentBlock[] = [];
    let stopReason: string | undefined;
    let currentToolUse: Partial<Anthropic.Messages.ToolUseBlock> | null = null;
    let accumulatedJson = "";

    for await (const event of stream) {
      if (event.type === "content_block_start") {
        if (event.content_block.type === "text") {
          currentMessage.push({ ...event.content_block, text: "" });
        } else if (event.content_block.type === "tool_use") {
          currentToolUse = { ...event.content_block, input: {} };
        }
      } else if (event.type === "content_block_delta") {
        if ("text" in event.delta) {
          const lastBlock = currentMessage[currentMessage.length - 1];
          if (lastBlock && lastBlock.type === "text") {
            lastBlock.text += event.delta.text;
            Deno.stdout.writeSync(new TextEncoder().encode(event.delta.text));
          }
        } else if ("partial_json" in event.delta && currentToolUse) {
          // Accumulate partial JSON for tool use
          accumulatedJson += event.delta.partial_json;
          try {
            const parsedJson = JSON.parse(accumulatedJson);
            if (!currentToolUse.input) currentToolUse.input = {};
            Object.assign(currentToolUse.input, parsedJson);
            accumulatedJson = ""; // Reset accumulated JSON
          } catch (error) {
            // If parsing fails, continue accumulating
          }
        }
      } else if (event.type === "content_block_stop") {
        if (currentToolUse) {
          currentMessage.push(
            currentToolUse as Anthropic.Messages.ToolUseBlock
          );
          currentToolUse = null;
          accumulatedJson = ""; // Reset accumulated JSON
        }
      } else if (event.type === "message_delta") {
        if (event.delta.stop_reason) {
          stopReason = event.delta.stop_reason;
        }
      }
    }

    conversation.push({
      role: "assistant",
      content: currentMessage,
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
      const toolCalls = currentMessage.filter(
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
        conversation.push(msg);
      }
    }
  }

  return conversation;
}
