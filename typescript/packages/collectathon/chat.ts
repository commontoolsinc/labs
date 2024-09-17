import { CoreMessage } from "npm:ai@3.3.21";
import { chat } from "./llm.ts";
import { db } from "./db.ts";

function formatCollectionItems(collections: string[]): string {
  let formattedContent = "";

  for (const collection of collections) {
    formattedContent += `<user-context-collection name="${collection}">\n`;

    const items = db.query<[number, string, string, string]>(
      `SELECT i.id, i.title, i.content, i.raw_content
       FROM items i
       JOIN item_collections ic ON i.id = ic.item_id
       JOIN collections c ON ic.collection_id = c.id
       WHERE c.name = ?`,
      [collection],
    );

    for (const [id, title, content, rawContent] of items) {
      formattedContent += `<user-context-item id="${id}" title="${title}">\n`;
      formattedContent += `${content}\n`;
      formattedContent += `</user-context-item>\n\n`;
    }

    formattedContent += `</user-context-collection>\n\n`;
  }

  return formattedContent;
}

export async function startChat(initialCollections: string[]) {
  let collections = initialCollections;
  let contextContent = formatCollectionItems(collections);

  let systemPrompt = `You are an AI assistant engaging in a conversation about the following collections of items. Use this context to inform your responses:

${contextContent}

Respond conversationally and draw upon the context provided when relevant.`;

  console.log(
    "Starting chat. Type '/exit' to leave, '/drop [collection]' to remove a collection, or '/add [collection]' to add a collection.",
  );

  const messages: CoreMessage[] = [];

  function refreshContext() {
    contextContent = formatCollectionItems(collections);
    systemPrompt = `You are an AI assistant engaging in a conversation about the following collections of items. Use this context to inform your responses:

  ${contextContent}

  Respond conversationally and draw upon the context provided when relevant.`;
  }

  while (true) {
    const userInput = prompt("User: ");
    if (!userInput) continue;

    if (userInput.startsWith("/")) {
      const [command, ...args] = userInput.slice(1).split(" ");
      switch (command) {
        case "exit":
          console.log("Exiting chat mode.");
          return;
        case "drop":
          if (args.length === 0) {
            console.log("Usage: /drop [collection]");
          } else {
            const collectionToDrop = args.join(" ");
            collections = collections.filter((c) => c !== collectionToDrop);
            console.log(`Dropped collection: ${collectionToDrop}`);
            refreshContext();
          }
          break;
        case "add":
          if (args.length === 0) {
            console.log("Usage: /add [collection]");
          } else {
            const collectionToAdd = args.join(" ");
            if (!collections.includes(collectionToAdd)) {
              collections.push(collectionToAdd);
              console.log(`Added collection: ${collectionToAdd}`);
              refreshContext();
            } else {
              console.log(`Collection ${collectionToAdd} is already included.`);
            }
          }
          break;
        case "refresh":
          console.log("Refreshing context.");
          refreshContext();
          break;
        default:
          console.log(
            "Unknown command. Available commands: /exit, /drop [collection], /add [collection], /refresh",
          );
      }
    } else {
      messages.push({ role: "user", content: userInput });

      const response = await chat(systemPrompt, messages);

      messages.push({ role: "assistant", content: response });
    }
  }
}
