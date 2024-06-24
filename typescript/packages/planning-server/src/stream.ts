import { Anthropic } from "./deps.ts";

export async function processStream(
  stream: AsyncIterable<Anthropic.Messages.MessageStreamEvent>
) {
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
        currentMessage.push(currentToolUse as Anthropic.Messages.ToolUseBlock);
        currentToolUse = null;
        accumulatedJson = ""; // Reset accumulated JSON
      }
    } else if (event.type === "message_delta") {
      if (event.delta.stop_reason) {
        stopReason = event.delta.stop_reason;
      }
    }
  }

  return { message: currentMessage, stopReason };
}
