import Instructor from '@instructor-ai/instructor';
import OpenAI from 'openai';
import { fetchApiKey } from './apiKey.js';
import {
  ChatCompletionMessage,
  ChatCompletionMessageParam,
  ChatCompletionTool
} from 'openai/resources';

const apiKey = fetchApiKey() as string;

const openai = new OpenAI({
  apiKey: apiKey,
  dangerouslyAllowBrowser: true
});

const toolSpec: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'listNodes',
      description: 'Lists all nodes in the graph.',
      parameters: {}
    }
  },
  {
    type: 'function',
    function: {
      name: 'addCodeNode',
      description: 'Adds a new code node to the graph written in javascript.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          node: {
            type: 'object',
            properties: {
              in: {
                type: 'object'
              },
              outputType: {
                type: 'object'
              }
            }
          },
          code: { type: 'string' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'addUiNode',
      description:
        'Adds a new ui node to the graph written using a hyperscript style.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          node: {
            type: 'object',
            properties: {
              in: {
                type: 'object'
              },
              outputType: {
                type: 'object'
              }
            }
          },
          body: { type: 'object' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'addFetchNode',
      description:
        'Adds a new fetch node to the graph to retrieve (GET) data from the web.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          url: { type: 'string' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'addMusicSearchNode',
      description: `Adds a new fetch node to the graph to search last.fm.

      Results are stored in result.albumsmatches.album
      `,
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          query: { type: 'string' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'replaceNode',
      description: 'Replaces an existing node in the graph.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          newNode: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              data: { type: 'object' }
            },
            required: ['id', 'data']
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'deleteNode',
      description: 'Deletes a node from the graph.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'getNodeOutputValue',
      description: 'Snapshot the current value of node from the graph.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' }
        }
      }
    }
  }
];

let model = 'gpt-4o';
// let model = "gpt-4-turbo-preview";
export const client = Instructor({
  client: openai,
  mode: 'JSON'
});

export async function generateImage(prompt: string) {
  const response = await openai.images.generate({
    model: 'dall-e-3',
    prompt: prompt,
    n: 1,
    size: '1024x1024'
  });
  return response.data[0].url;
}

export async function processUserInput(
  input: string,
  system: string,
  availableFunctions: { [key: string]: Function }
) {
  let messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: system },
    { role: 'user', content: input }
  ];

  let running = true;
  while (running) {
    console.log('messages', messages);
    const response = await client.chat.completions.create({
      messages,
      model,
      tools: toolSpec,
      tool_choice: 'auto',
      temperature: 0
    });

    if (response.choices[0].finish_reason === 'stop') {
      return response;
    }

    const latest = response.choices[0].message;
    messages.push(latest);

    const toolCalls = latest.tool_calls;
    if (toolCalls) {
      for (const toolCall of toolCalls) {
        console.log('toolCall', toolCall);
        const functionName = toolCall.function.name;
        const functionToCall = availableFunctions[functionName];
        // escape all newlines in arguments string
        const functionArgs = JSON.parse(
          toolCall.function.arguments.replace(/\n/g, '\n')
        );
        const functionResponse = functionToCall(functionArgs);
        console.log('response', toolCall.id, functionResponse);
        messages.push({
          tool_call_id: toolCall.id,
          role: 'tool',
          content: functionResponse
        });
      }
    }
  }
}

export async function doLLM(
  input: string,
  system: string,
  response_model: any
) {
  try {
    console.log('input', input);
    console.log('system', system);

    return await client.chat.completions.create({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: input }
      ],
      model
    });
  } catch (error) {
    console.error('Error analyzing text:', error);
    return null;
  }
}

export function grabViewTemplate(txt: string) {
  return txt.match(/```vue\n([\s\S]+?)```/)?.[1];
}

export function grabJson(txt: string) {
  return JSON.parse(txt.match(/```json\n([\s\S]+?)```/)[1]);
}

export function extractResponse(data: any) {
  return data.choices[0].message.content;
}

export function extractImage(data: any) {
  return data.data[0].url;
}
