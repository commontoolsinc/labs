import { ChatCompletionTool } from "openai/resources/index.mjs";

export function describeTools(
  tools: ChatCompletionTool[],
  includeParameters: boolean = false
) {
  return tools
    .map((tool) => {
      const description = `- ${tool.function.name}: ${tool.function.description}`;
      const properties = Object.entries(
        tool.function.parameters?.properties || {}
      )
        .map(([name, { type, description }]) => {
          return `  - ${name} (${type}): ${description}`;
        })
        .join("\n");
      if (!includeParameters) {
        return description;
      }
      return `${description}\n${properties}`;
    })
    .join("\n");
}

export const toolSpec: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "addCodeNode",
      description:
        "Add a data transformation node to the graph written in javascript, write only the function body.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          code: { type: "string" }
        },
        required: ["id", "code"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "addUiNode",
      description: "Adds a UI node written using a hyperscript tree. Only use span, ul, button and h1 elements for now.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          uiTree: { type: "object", description: "The UI tree." }
        },
        required: ["id", "uiTree"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "addEventNode",
      description:
        "A node that will be bound to a user-input event from a UI node.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "addStorageNode",
      description:
        "A node that will persist data to the passed address, for retrieval later.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          address: { type: "string" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "addConnection",
      description: "Adds a connection between two existing nodes.",
      parameters: {
        type: "object",
        properties: {
          from: {
            type: "string",
            description: "Path of the OUTPUT node in the graph"
          },
          to: {
            type: "array",
            items: { type: "string" },
            description:
              "Path to the INPUT node + port to connect to, e.g. ['nodeId', 'portName']"
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "deleteNode",
      description: "Deletes a node from the graph.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "addClockNode",
      description:
        "A node that emit an incrementing value every second, starting from 0.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "addFetchNode",
      description: "Fetch node to retrieve (GET) data from the web.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          url: { type: "string" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "addGlslShaderNode",
      description:
        "Shader node in ShaderToy format. iTime, iResolution, iMouse and iChannel0 (the user's webcam). Do not re-define them.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          shaderToyCode: { type: "string" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "addLanguageModelNode",
      description:
        "LLM node to the graph, responds in text format. Prompt must be calculated using a code node.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          promptSource: {
            type: "string",
            description:
              "Name of the node who's output should be used as the prompt"
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "addImageGenerationNode",
      description:
        "Generate an image from a prompt/description. The output is the URL.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          promptSource: {
            type: "string",
            description:
              "Name of the node who's output should be used as the prompt"
          }
        }
      }
    }
  }
];
