import { Module, NAME, Recipe } from "@commontools/runner";
import { Charm, CharmManager, charmSchema } from "./index.ts";
import { Cell, getEntityId, isCell, isStream } from "@commontools/runner";

/**
 * Converts a string of multiple words into camelCase format
 * @param input - The string to convert
 * @returns The camelCased string
 *
 * Examples:
 * - "hello world" -> "helloWorld"
 * - "The quick brown FOX" -> "theQuickBrownFox"
 * - "this-is-a-test" -> "thisIsATest"
 * - "already_camel_case" -> "alreadyCamelCase"
 */
function toCamelCase(input: string): string {
  // Handle empty string case
  if (!input) return "";

  // Split the input string by non-alphanumeric characters
  return input
    .split(/[^a-zA-Z0-9]/)
    .filter((word) => word.length > 0) // Remove empty strings
    .map((word, index) => {
      // First word should be all lowercase
      if (index === 0) {
        return word.toLowerCase();
      }
      // Other words should have their first letter capitalized and the rest lowercase
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join("");
}

export async function formatPromptWithMentions(
  prompt: string,
  charmManager: CharmManager,
): Promise<
  {
    text: string;
    sources: Record<
      string,
      { name: string; cell: Cell<Charm>; recipe?: Recipe | Module }
    >;
  }
> {
  const payload = await parseComposerDocument(
    prompt,
    charmManager,
  );

  // Create a mapping of IDs to source objects
  const sourcesMap: Record<string, any> = {};

  // Process the text to inject IDs where mentions are
  let processedText = payload.text;

  // Check if there are any sources to process
  if (payload.sources && Object.keys(payload.sources).length > 0) {
    // Add each source to the map
    Object.entries(payload.sources).forEach(([id, source]) => {
      const shadowId = getCharmNameAsCamelCase(source.cell, sourcesMap);
      sourcesMap[shadowId] = source;

      // Replace the markdown link mention with the ID
      // Format: [character](charm://id)
      processedText = processedText.replace(
        new RegExp(`\\[(.*?)\\]\\(charm://${id}\\)`, "g"),
        `\`${shadowId}\``,
      );
    });
  }

  return {
    text: processedText,
    sources: sourcesMap,
  };
}

export function getCharmNameAsCamelCase(
  cell: Cell<any>,
  usedKeys: Record<string, any>,
): string {
  const charmName = toCamelCase(cell.asSchema(charmSchema).key(NAME).get());

  let name = charmName;
  let num = 0;

  while (name in usedKeys) name = charmName + `${++num}`;

  return name;
}

// Type definition for Slate document node structure
type Descendant = {
  type?: string;
  text?: string;
  id?: string;
  character?: string;
  bold?: boolean;
  italic?: boolean;
  children?: Descendant[];
};

// Helper to add markdown styling based on node type
async function processNode(
  node: any,
  state: {
    fullText: string;
    mentions: string[];
    sources: {
      [id: string]: { name: string; cell: Cell<any>; recipe?: Recipe | Module };
    };
    mentionIndices: Record<string, number>;
  },
  charmManager?: CharmManager,
  currentList: { type: string | null; level: number } = {
    type: null,
    level: 0,
  },
): Promise<void> {
  if (node.type === "mention") {
    if (node.id) {
      // Add to mentions list if not already present
      if (!state.mentionIndices[node.id]) {
        state.mentions.push(node.id);

        // Create bibliography entry if charmManager is provided
        const bibIndex = Object.keys(state.sources).length + 1;

        if (charmManager) {
          const charm = await charmManager.get(node.id);
          if (charm) {
            state.sources[node.id] = {
              name: node.character || `Reference ${bibIndex}`,
              cell: charm,
            };

            state.mentionIndices[node.id] = bibIndex;
          }
        }
      }

      // Add reference in markdown format
      state.fullText += `[${node.character}](charm://${node.id})`;
    } else {
      // Handle mentions without explicit IDs (plain text mentions)
      state.fullText += `@${node.character}`;
    }
  } else if (node.text !== undefined) {
    // Handle text with formatting
    let textContent = node.text;
    if (node.bold) textContent = `**${textContent}**`;
    if (node.italic) textContent = `*${textContent}*`;
    state.fullText += textContent;
  } else if (node.children) {
    // Handle block elements with markdown syntax
    switch (node.type) {
      case "heading-one": {
        state.fullText += "# ";
        break;
      }
      case "heading-two": {
        state.fullText += "## ";
        break;
      }
      case "heading-three": {
        state.fullText += "### ";
        break;
      }
      case "heading-four": {
        state.fullText += "#### ";
        break;
      }
      case "heading-five": {
        state.fullText += "##### ";
        break;
      }
      case "heading-six": {
        state.fullText += "###### ";
        break;
      }
      case "block-quote": {
        state.fullText += "> ";
        break;
      }
      case "bulleted-list": {
        // Just process children - the list items will add the markers
        for (const child of node.children) {
          await processNode(
            child,
            state,
            charmManager,
            {
              type: "bulleted-list",
              level: currentList.level + 1,
            },
          );
        }
        return; // Skip the default children processing below
      }
      case "list-item": {
        state.fullText += "* ";
        break;
      }
    }

    // Process children
    for (const child of node.children) {
      await processNode(child, state, charmManager, currentList);
    }

    // Add appropriate line breaks after block elements
    if (node.type && node.type !== "list-item") {
      state.fullText += "\n\n";
    } else if (node.type === "list-item") {
      state.fullText += "\n";
    }
  }
}

// Function to parse Slate document and extract mention references
export async function parseComposerDocument(
  serializedDocument: string,
  charmManager?: CharmManager,
): Promise<{
  text: string;
  mentions: string[];
  sources: {
    [id: string]: { name: string; cell: Cell<any>; recipe?: Recipe | Module };
  };
}> {
  try {
    if (serializedDocument.trim().length == 0) {
      return { text: "", mentions: [], sources: {} };
    }

    let document: Descendant[];

    try {
      document = JSON.parse(serializedDocument) as Descendant[];
    } catch (error) {
      console.warn(
        "Failed to parse JSON compose document, assuming plain text:",
      );
      return {
        text: serializedDocument,
        mentions: [],
        sources: {},
      };
    }

    // Create a state object to track changes
    const state = {
      fullText: "",
      mentions: [] as string[],
      sources: {} as {
        [id: string]: {
          name: string;
          cell: Cell<any>;
          recipe?: Recipe | Module;
        };
      },
      mentionIndices: {} as Record<string, number>,
    };

    // Process each node sequentially with await
    for (const node of document) {
      await processNode(node, state, charmManager);
    }

    return {
      text: state.fullText.trim(), // Remove extra whitespace
      mentions: state.mentions,
      sources: state.sources,
    };
  } catch (error) {
    console.warn("Failed to parse document, treating as plain text:", error);
    return { text: serializedDocument, mentions: [], sources: {} };
  }
}

// Helper function to replace mentions with their actual content
export function replaceMentionsWithContent(
  parsedDocument: { text: string; mentions: string[] },
  mentionContent: Record<string, any>,
): string {
  let result = parsedDocument.text;

  // Replace each mention with its content
  for (const mentionId of parsedDocument.mentions) {
    const content = mentionContent[mentionId];
    if (content) {
      // Find the mention pattern in the text and replace it with content
      const mentionRegex = new RegExp(`@[^@]+(#${mentionId})\\)`, "g");
      result = result.replace(mentionRegex, content);
    }
  }

  return result;
}
