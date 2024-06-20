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
  const message = await anthropic.messages.create({
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: text,
      },
    ],
    model: "claude-3-5-sonnet-20240620",
  });

  return message.content[0].text;
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
    const message = await anthropic.messages.create({
      max_tokens: 1024,
      messages: conversation,
      model: "claude-3-5-sonnet-20240620",
      tools: tools,
    });

    conversation.push({
      role: "assistant",
      content: message.content,
    });

    console.log("Message", message.stop_reason);
    if (
      message.stop_reason == "stop_sequence" ||
      message.stop_reason == "end_turn" ||
      message.stop_reason == "max_tokens"
    ) {
      console.log("Stopping conversation", message.stop_reason);
      running = false;
      return conversation;
    }

    if (message.stop_reason == "tool_use") {
      const toolCalls = message.content.filter(
        (msg) => msg.type === "tool_use"
      ) as Anthropic.Messages.ToolUseBlock[];
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
