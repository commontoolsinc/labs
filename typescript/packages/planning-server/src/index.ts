import Anthropic from "npm:@anthropic-ai/sdk";
import { config } from "https://deno.land/x/dotenv/mod.ts";
await config({ export: true });

const anthropic = new Anthropic({
  apiKey: Deno.env.get("ANTHROPIC_API_KEY"),
});

const tools: Anthropic.Messages.Tool[] = [
  {
    name: "rhyme",
    description: "Generate rhyming words",
    input_schema: {
      type: "object",
      properties: {
        word: {
          type: "string",
        },
      },
      required: ["word"],
    },
  },
];

async function single(text: string) {
  let response = "";
  const stream = await anthropic.messages.stream({
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: text,
      },
    ],
    model: "claude-3-5-sonnet-20240620",
  });

  for await (const event of stream) {
    if (event.type === "content_block_delta") {
      response += event.delta.text;
      Deno.stdout.writeSync(new TextEncoder().encode(event.delta.text));
    }
  }

  return response;
}

async function main() {
  let conversation: Anthropic.Messages.MessageParam[] = [
    {
      role: "user",
      content:
        "Find words that rhyme with 'orange' and 'purple'. Respond with a dot point list.",
    },
  ];

  let running = true;
  while (running) {
    console.log("Conversation", conversation);
    const stream = await anthropic.messages.stream({
      max_tokens: 1024,
      messages: conversation,
      model: "claude-3-5-sonnet-20240620",
      tools: tools,
    });

    let currentMessage: Anthropic.Messages.ContentBlock[] = [];
    let stopReason: string | undefined;

    for await (const event of stream) {
      if (event.type === "content_block_start") {
        if (
          event.content_block.type === "text" ||
          event.content_block.type === "tool_use"
        ) {
          currentMessage.push({ ...event.content_block, text: "" });
        }
      } else if (event.type === "content_block_delta") {
        const lastBlock = currentMessage[currentMessage.length - 1];
        if (lastBlock && lastBlock.type === "text") {
          lastBlock.text += event.delta.text;
          Deno.stdout.writeSync(new TextEncoder().encode(event.delta.text));
        } else if (lastBlock && lastBlock.type === "tool_use") {
          Object.assign(lastBlock, event.delta);
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
        switch (tool.name) {
          case "rhyme":
            return [
              tool.id,
              await single(`what rhymes with ${input.word}?`),
            ] as const;
          default:
            return [
              tool.id,
              await new Promise<string>((resolve) => resolve("")),
            ] as const;
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
              text: result,
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

const result = await main();
console.log("Final Result", result);
const last = result[result.length - 1];
const output = (last.content as any[]).map((msg) => msg.text);
for (const msg of output) {
  Deno.stdout.write(
    new TextEncoder().encode(`[${output.indexOf(msg)}] ${msg}`)
  );
}
