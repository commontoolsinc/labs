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
  {
    name: "summarize",
    description: "Summarize a given text",
    input_schema: {
      type: "object",
      properties: {
        text: {
          type: "string",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "sentimentAnalysis",
    description: "Analyze the sentiment of a given text",
    input_schema: {
      type: "object",
      properties: {
        text: {
          type: "string",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "exaggerate",
    description: "Exaggerate the given text",
    input_schema: {
      type: "object",
      properties: {
        text: {
          type: "string",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "makeSadder",
    description: "Make the given text sadder",
    input_schema: {
      type: "object",
      properties: {
        text: {
          type: "string",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "makeHappier",
    description: "Make the given text happier",
    input_schema: {
      type: "object",
      properties: {
        text: {
          type: "string",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "capitalize",
    description: "Capitalize all words in the given text",
    input_schema: {
      type: "object",
      properties: {
        text: {
          type: "string",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "translateToFrench",
    description: "Translate the given text to French",
    input_schema: {
      type: "object",
      properties: {
        text: {
          type: "string",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "countWords",
    description: "Count the number of words in the given text",
    input_schema: {
      type: "object",
      properties: {
        text: {
          type: "string",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "reverseText",
    description: "Reverse the characters in the given text",
    input_schema: {
      type: "object",
      properties: {
        text: {
          type: "string",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "removeVowels",
    description: "Remove all vowels from the given text",
    input_schema: {
      type: "object",
      properties: {
        text: {
          type: "string",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "convertToPigLatin",
    description: "Convert the given text to Pig Latin",
    input_schema: {
      type: "object",
      properties: {
        text: {
          type: "string",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "addEmojis",
    description: "Add relevant emojis to the given text",
    input_schema: {
      type: "object",
      properties: {
        text: {
          type: "string",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "convertToLeetSpeak",
    description: "Convert the given text to Leet Speak",
    input_schema: {
      type: "object",
      properties: {
        text: {
          type: "string",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "generateAcronym",
    description: "Generate an acronym from the given text",
    input_schema: {
      type: "object",
      properties: {
        text: {
          type: "string",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "shuffleWords",
    description: "Randomly shuffle the words in the given text",
    input_schema: {
      type: "object",
      properties: {
        text: {
          type: "string",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "convertToMorseCode",
    description: "Convert the given text to Morse code",
    input_schema: {
      type: "object",
      properties: {
        text: {
          type: "string",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "emphasizeKeywords",
    description: "Emphasize important keywords in the given text",
    input_schema: {
      type: "object",
      properties: {
        text: {
          type: "string",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "generateHashtags",
    description: "Generate relevant hashtags for the given text",
    input_schema: {
      type: "object",
      properties: {
        text: {
          type: "string",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "convertToCamelCase",
    description: "Convert the given text to camelCase",
    input_schema: {
      type: "object",
      properties: {
        text: {
          type: "string",
        },
      },
      required: ["text"],
    },
  },
];

const toolImpls: { [id: string]: Function } = {
  rhyme: async (input: { word: string }) => {
    return await single(`what rhymes with ${input.word}?`);
  },
  summarize: async (input: { text: string }) => {
    return await single(`Summarize the following text: ${input.text}`);
  },
  sentimentAnalysis: async (input: { text: string }) => {
    return await single(
      `Analyze the sentiment of the following text: ${input.text}`
    );
  },
  exaggerate: async (input: { text: string }) => {
    return await single(`Exaggerate the following text: ${input.text}`);
  },
  makeSadder: async (input: { text: string }) => {
    return await single(`Make the following text sadder: ${input.text}`);
  },
  makeHappier: async (input: { text: string }) => {
    return await single(`Make the following text happier: ${input.text}`);
  },
  capitalize: async (input: { text: string }) => {
    return input.text
      .split(" ")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  },
  translateToFrench: async (input: { text: string }) => {
    return await single(
      `Translate the following text to French: ${input.text}`
    );
  },
  countWords: async (input: { text: string }) => {
    return input.text.split(/\s+/).filter((word) => word.length > 0).length;
  },
  reverseText: async (input: { text: string }) => {
    return input.text.split("").reverse().join("");
  },
  removeVowels: async (input: { text: string }) => {
    return input.text.replace(/[aeiou]/gi, "");
  },
  convertToPigLatin: async (input: { text: string }) => {
    return await single(
      `Convert the following text to Pig Latin: ${input.text}`
    );
  },
  addEmojis: async (input: { text: string }) => {
    return await single(
      `Add relevant emojis to the following text: ${input.text}`
    );
  },
  convertToLeetSpeak: async (input: { text: string }) => {
    return await single(
      `Convert the following text to Leet Speak: ${input.text}`
    );
  },
  generateAcronym: async (input: { text: string }) => {
    return input.text
      .split(/\s+/)
      .map((word) => word[0].toUpperCase())
      .join("");
  },
  shuffleWords: async (input: { text: string }) => {
    const words = input.text.split(/\s+/);
    for (let i = words.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [words[i], words[j]] = [words[j], words[i]];
    }
    return words.join(" ");
  },
  convertToMorseCode: async (input: { text: string }) => {
    return await single(
      `Convert the following text to Morse code: ${input.text}`
    );
  },
  emphasizeKeywords: async (input: { text: string }) => {
    return await single(
      `Emphasize important keywords in the following text: ${input.text}`
    );
  },
  generateHashtags: async (input: { text: string }) => {
    return await single(
      `Generate relevant hashtags for the following text: ${input.text}`
    );
  },
  convertToCamelCase: async (input: { text: string }) => {
    return input.text
      .replace(/(?:^\w|[A-Z]|\b\w)/g, (word, index) =>
        index === 0 ? word.toLowerCase() : word.toUpperCase()
      )
      .replace(/\s+/g, "");
  },
};

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

// get cli argument
const args = Deno.args;
if (args.length === 0) {
  console.error("Please provide a question to ask.");
  Deno.exit(1);
}
const question = args.join(" ");

async function main() {
  let conversation: Anthropic.Messages.MessageParam[] = [
    {
      role: "user",
      content: question,
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
