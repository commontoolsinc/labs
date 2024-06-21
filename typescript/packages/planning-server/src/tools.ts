import { HAIKU, single } from "./anthropic.ts";
import { Anthropic } from "./deps.ts";

export async function processTools(
  message: Anthropic.Messages.ContentBlock[],
  toolImpls: ToolImpls
) {
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
    return msg;
  }
  return undefined;
}

export const tools: Anthropic.Messages.Tool[] = [
  {
    name: "extractSemanticTriples",
    description: "Extract RDF triples from a given text",
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
  {
    name: "getCurrentDate",
    description: "Get the current date and time",
    input_schema: {
      type: "object",
      properties: {
        timezone: {
          type: "string",
        },
      },
      required: ["timezone"],
    },
  },
  {
    name: "getSystemMemoryUsage",
    description: "Get the current system memory usage",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "getRandomNumber",
    description: "Generate a random number within a given range",
    input_schema: {
      type: "object",
      properties: {
        min: {
          type: "number",
        },
        max: {
          type: "number",
        },
      },
      required: ["min", "max"],
    },
  },
  {
    name: "getEnvironmentVariable",
    description: "Get the value of an environment variable",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "getFileContents",
    description: "Get the contents of a file",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "listDirectoryContents",
    description: "List the contents of a directory",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "getNetworkInterfaces",
    description: "Get information about network interfaces",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "getDiskSpace",
    description: "Get available disk space",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "getOSInfo",
    description: "Get information about the operating system",
    input_schema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "checkWebsiteStatus",
    description: "Check if a website is up and running",
    input_schema: {
      type: "object",
      properties: {
        url: {
          type: "string",
        },
      },
      required: ["url"],
    },
  },
];

export type ToolImpl = (input: { text: string }) => Promise<string>;
export type ToolImpls = { [id: string]: ToolImpl };
export const toolImpls: ToolImpls = {
  extractSemanticTriples: async (input: { text: string }) => {
    return await single(
      `You specialize in extracting semantic RDF triples, right?
      You've done this before. Here's an example of your work:

      <input_example>
        timestamp: 2024-06-20 5:16PM (PST)
        location: Berkely, California
        weather: 18C, Sunny
        scope: work
        author: user
        tags: #work #demoscene #vega-lite

        created a UI for rendering 2D grids using vega-lite
        tied it to a clock for realtime graphics

        CONNECTION: user enjoys computer graphics demos
        QUESTION: how can we achieve other interesting animations?

        {
          “dimensions”: [10, 10],
          “request”: “create a clock node, pipe it into a code node to make a 2d grid of values based on Math.sin of the current tick value and then visualize it as a heatmap using vega-lite (declare the spec in a code node)”
        }
      </input_example>

      <response_example>
        { ':db/id': -1,
          'note/timestamp': new Date("2024-06-20T17:16:00-07:00"),
          'note/location': "Berkely, California",
          'note/weather': "18C, Sunny",
          'note/scope': "work",
          'note/author': "user",
          'note/tag': ["work", "demoscene", "vega-lite"],
          'note/content': [
            "created a UI for rendering 2D grids using vega-lite",
            "tied it to a clock for realtime graphics"
          ],
          'note/connection': "user enjoys computer graphics demos",
          'note/question': "how can we achieve other interesting animations?",
          'note/dimensions': [10, 10],
          'note/request': "create a clock node, pipe it into a code node to make a 2d grid of values based on Math.sin of the current tick value and then visualize it as a heatmap using vega-lite (declare the spec in a code node)"
        }
      </response_example>

      Now, extract and format RDF triples from the following text:

      <input>${input.text}</input> for use in the javascript client of https://github.com/tonsky/datascript.`
    );
  },
  rhyme: async (input: { word: string }) => {
    return await single(`what rhymes with ${input.word}?`);
  },
  summarize: async (input: { text: string }) => {
    return await single(
      `Summarize the following text in a single paragraph: ${input.text}`,
      HAIKU
    );
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
    return await single(`Make the following text sadder: ${input.text}`, HAIKU);
  },
  makeHappier: async (input: { text: string }) => {
    return await single(
      `Make the following text happier: ${input.text}`,
      HAIKU
    );
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
      `Convert the following text to Leet Speak: ${input.text}`,
      HAIKU
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
      `Generate relevant hashtags for the following text: ${input.text}`,
      HAIKU
    );
  },
  convertToCamelCase: async (input: { text: string }) => {
    return input.text
      .replace(/(?:^\w|[A-Z]|\b\w)/g, (word, index) =>
        index === 0 ? word.toLowerCase() : word.toUpperCase()
      )
      .replace(/\s+/g, "");
  },
  getCurrentDate: async (input: { timezone: string }) => {
    return new Date().toLocaleString("en-US", { timeZone: input.timezone });
  },
  getSystemMemoryUsage: async () => {
    const memoryUsage = Deno.memoryUsage();
    return {
      rss: memoryUsage.rss,
      heapTotal: memoryUsage.heapTotal,
      heapUsed: memoryUsage.heapUsed,
      external: memoryUsage.external,
    };
  },
  getRandomNumber: async (input: { min: number; max: number }) => {
    return Math.floor(Math.random() * (input.max - input.min + 1)) + input.min;
  },
  getEnvironmentVariable: async (input: { name: string }) => {
    return Deno.env.get(input.name) || "Environment variable not found";
  },
  getFileContents: async (input: { path: string }) => {
    try {
      return await Deno.readTextFile(input.path);
    } catch (error) {
      return `Error reading file: ${error.message}`;
    }
  },
  listDirectoryContents: async (input: { path: string }) => {
    try {
      const entries = [];
      for await (const entry of Deno.readDir(input.path)) {
        entries.push(entry.name);
      }
      return entries;
    } catch (error) {
      return `Error listing directory: ${error.message}`;
    }
  },
  getNetworkInterfaces: async () => {
    const networkInterfaces = Deno.networkInterfaces();
    return JSON.stringify(networkInterfaces, null, 2);
  },
  getDiskSpace: async () => {
    // Note: Deno doesn't have a built-in way to get disk space.
    // This is a placeholder that returns a mock result.
    return {
      total: "1000GB",
      free: "500GB",
      used: "500GB",
    };
  },
  getOSInfo: async () => {
    return {
      os: Deno.build.os,
      arch: Deno.build.arch,
    };
  },
  checkWebsiteStatus: async (input: { url: string }) => {
    try {
      const response = await fetch(input.url);
      return {
        status: response.status,
        statusText: response.statusText,
        ok: response.ok,
      };
    } catch (error) {
      return `Error checking website: ${error.message}`;
    }
  },
};
