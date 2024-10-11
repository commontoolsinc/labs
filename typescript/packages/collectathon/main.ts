import { addActionCommand } from "./action.ts";
import { startChat } from "./chat.ts";
import {
  addItemToCollection,
  deleteCollection,
  listCollections,
  listItems,
  removeItemFromCollection,
  moveCollection,
} from "./collections.ts";
import { readLines } from "./deps.ts";
import { addDreamCommand } from "./dream.ts";
import { importFiles, clipUrl } from "./import.ts";
import { deleteItem, editItemCLI, printItem, purge } from "./items.ts";
import { addRule, applyRules, deleteRule, listRules } from "./rules.ts";
import { search } from "./search.ts";
import { handleViewCommandInteractive } from "./view.ts";

function listAPI() {
  console.log("Available commands:");
  console.log("  clip <URL> <COLLECTION> [-p PROMPT]");
  console.log("  collection list");
  console.log("  collection delete <COLLECTION>");
  console.log("  collection apply-rules <COLLECTION>");
  console.log("  collection move <COLLECTION> <NEW_NAME>");
  console.log("  item list <COLLECTION>");
  console.log("  item show <ITEM_ID> [-raw]");
  console.log("  item delete <ITEM_ID>");
  console.log("  item edit <ITEM_ID> [-raw]");
  console.log("  item add <ITEM_ID> <COLLECTION>");
  console.log("  item remove <ITEM_ID> <COLLECTION>");
  console.log("  item purge");
  console.log("  rule add <COLLECTION> <RULE> <TARGET_COLLECTION>");
  console.log("  rule list <COLLECTION>");
  console.log("  rule delete <RULE_ID>");
  console.log("  chat <COLLECTION1> [COLLECTION2 ...]");
  console.log("  import <PATH> <COLLECTION> [FILE_TYPE_FILTER]");
  console.log("  search <QUERY>");
  console.log("  action <COLLECTION> <PROMPT>");
  console.log("  dream <COLLECTION>");
  console.log("  view <COLLECTION> <PROMPT>");
  console.log("  exit");
}

async function main() {
  console.log("Welcome to the Collection Clipper CLI!");
  listAPI();

  for await (const line of readLines(Deno.stdin)) {
    const args = line.trim().split(" ");
    const command = args.shift()?.toLowerCase();

    switch (command) {
      case "clip":
        if (args.length < 2) {
          console.log("Usage: clip <URL> <COLLECTION> [-p PROMPT]");
        } else {
          const [url, collection, ...rest] = args;
          const promptIndex = rest.indexOf("-p");
          const prompt =
            promptIndex !== -1
              ? rest.slice(promptIndex + 1).join(" ")
              : undefined;

          clipUrl(url, collection, prompt, undefined);
        }
        break;
      case "collection":
        if (args.length < 1) {
          console.log("Usage: collection <action> [arguments]");
          break;
        }
        const collectionAction = args.shift();
        switch (collectionAction) {
          case "list":
            await listCollections();
            break;
          case "delete":
            if (args.length !== 1) {
              console.log("Usage: collection delete <COLLECTION>");
            } else {
              await deleteCollection(args[0]);
            }
            break;
          case "apply-rules":
            if (args.length !== 1) {
              console.log("Usage: collection apply-rules <COLLECTION>");
            } else {
              await applyRules(args[0]);
            }
            break;
          case "move":
            if (args.length !== 2) {
              console.log("Usage: collection move <COLLECTION> <NEW_NAME>");
            } else {
              await moveCollection(args[0], args[1]);
            }
            break;
          default:
            console.log(
              "Unknown collection action. Available actions: list, delete, apply-rules, move",
            );
        }
        break;
      case "item":
        if (args.length < 1) {
          console.log("Usage: item <action> [arguments]");
          break;
        }
        const itemAction = args.shift();
        switch (itemAction) {
          case "list":
            if (args.length !== 1) {
              console.log("Usage: item list <COLLECTION>");
            } else {
              await listItems(args[0]);
            }
            break;
          case "show":
            if (args.length < 1) {
              console.log("Usage: item show <ITEM_ID> [-raw]");
            } else {
              const itemId = parseInt(args[0]);
              const showRaw = args[1] === "-raw";
              printItem(itemId, showRaw);
            }
            break;
          case "delete":
            if (args.length !== 1) {
              console.log("Usage: item delete <ITEM_ID>");
            } else {
              deleteItem(parseInt(args[0]));
            }
            break;
          case "edit":
            if (args.length < 1 || args.length > 2) {
              console.log("Usage: item edit <ITEM_ID> [-raw]");
            } else {
              const itemId = parseInt(args[0]);
              const editRaw = args[1] === "-raw";
              await editItemCLI(itemId, editRaw);
            }
            break;
          case "add":
            if (args.length !== 2) {
              console.log("Usage: item add <ITEM_ID> <COLLECTION>");
            } else {
              await addItemToCollection(parseInt(args[0]), args[1]);
            }
            break;
          case "remove":
            if (args.length !== 2) {
              console.log("Usage: item remove <ITEM_ID> <COLLECTION>");
            } else {
              await removeItemFromCollection(parseInt(args[0]), args[1]);
            }
            break;
          case "purge":
            await purge();
            break;
          default:
            console.log(
              "Unknown item action. Available actions: list, show, delete, edit, add, remove, purge",
            );
        }
        break;
      case "rule":
        if (args.length < 1) {
          console.log("Usage: rule <action> [arguments]");
          break;
        }
        const ruleAction = args.shift();
        switch (ruleAction) {
          case "add":
            if (args.length < 3) {
              console.log(
                "Usage: rule add <COLLECTION> <RULE> <TARGET_COLLECTION>",
              );
            } else {
              const collection = args.shift()!;
              const targetCollection = args.pop()!;
              const rule = args.join(" ");
              await addRule(collection, rule, targetCollection);
            }
            break;
          case "list":
            if (args.length !== 1) {
              console.log("Usage: rule list <COLLECTION>");
            } else {
              await listRules(args[0]);
            }
            break;
          case "delete":
            if (args.length !== 1) {
              console.log("Usage: rule delete <RULE_ID>");
            } else {
              await deleteRule(parseInt(args[0]));
            }
            break;
          default:
            console.log(
              "Unknown rule action. Available actions: add, list, delete",
            );
        }
        break;
      case "chat":
        if (args.length < 1) {
          console.log("Usage: chat <COLLECTION1> [COLLECTION2 ...]");
        } else {
          await startChat(args);
        }
        break;
      case "import":
        if (args.length < 2 || args.length > 3) {
          console.log("Usage: import <PATH> <COLLECTION> [FILE_TYPE_FILTER]");
        } else {
          const [path, collection, fileTypeFilter] = args;
          await importFiles(path, collection, fileTypeFilter);
        }
        break;
      case "search":
        if (args.length === 0) {
          console.log("Usage: search <QUERY>");
        } else {
          const query = args.join(" ");
          await search(query);
        }
        break;
      case "action":
        addActionCommand(args);
        break;
      case "dream":
        addDreamCommand(args);
        break;
      case "view":
        if (args.length < 2) {
          console.log("Usage: view <COLLECTION> <INITIAL_PROMPT>");
        } else {
          const collection = args.shift()!;
          const initialPrompt = args.join(" ");
          await handleViewCommandInteractive(collection, initialPrompt);
        }
        break;
      case "exit":
        console.log("Goodbye!");
        Deno.exit(0);
        break;
      default:
        console.log("Unknown command.");
        listAPI();
    }
  }
}

if (import.meta.main) {
  main();
}
