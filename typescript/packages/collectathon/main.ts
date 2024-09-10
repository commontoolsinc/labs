// main.ts
import { startChat } from "./chat.ts";
import {
  addItemToCollection,
  deleteCollection,
  listCollections,
  listItems,
  removeItemFromCollection,
} from "./collections.ts";
import { readLines } from "./deps.ts";
import { clipGitHub } from "./github.ts";
import { printItem } from "./items.ts";
import { clipRSS } from "./rss.ts";
import { addRule, applyRules, deleteRule, listRules } from "./rules.ts";
import { clipWebpage } from "./webpage.ts";

async function main() {
  console.log("Welcome to the Collection Clipper CLI!");
  console.log("Available commands:");
  console.log("  clip <URL> <COLLECTION> [-p PROMPT]");
  console.log("  collections");
  console.log("  items <COLLECTION>");
  console.log("  item <ITEM_ID> [-raw]");
  console.log("  add <ITEM_ID> <COLLECTION>");
  console.log("  remove <ITEM_ID> <COLLECTION>");
  console.log("  delete-collection <COLLECTION>");
  console.log("  rule <COLLECTION> <RULE> <TARGET_COLLECTION>");
  console.log("  rules <COLLECTION>");
  console.log("  delete-rule <RULE_ID>");
  console.log("  apply-rules <COLLECTION> [RULE_ID]");
  console.log("  chat <COLLECTION1> [COLLECTION2 ...]");
  console.log("  exit");

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

          if (url.includes("github.com")) {
            await clipGitHub(url, collection);
          } else if (url.includes(".rss") || url.includes("/feed")) {
            await clipRSS(url, collection);
          } else {
            await clipWebpage(url, collection, prompt);
          }
        }
        break;
      case "collections":
        await listCollections();
        break;
      case "items":
        if (args.length !== 1) {
          console.log("Usage: items <COLLECTION>");
        } else {
          await listItems(args[0]);
        }
        break;
      case "item":
        if (args.length < 1) {
          console.log("Usage: item <ITEM_ID> [-raw]");
        } else {
          const itemId = parseInt(args[0]);
          const showRaw = args[1] === "-raw";
          printItem(itemId, showRaw);
        }
        break;
      case "add":
        if (args.length !== 2) {
          console.log("Usage: add <ITEM_ID> <COLLECTION>");
        } else {
          await addItemToCollection(parseInt(args[0]), args[1]);
        }
        break;
      case "remove":
        if (args.length !== 2) {
          console.log("Usage: remove <ITEM_ID> <COLLECTION>");
        } else {
          await removeItemFromCollection(parseInt(args[0]), args[1]);
        }
        break;
      case "delete-collection":
        if (args.length !== 1) {
          console.log("Usage: delete-collection <COLLECTION>");
        } else {
          await deleteCollection(args[0]);
        }
        break;
      case "exit":
        console.log("Goodbye!");
        Deno.exit(0);
        break;
      case "rule":
        if (args.length < 3) {
          console.log("Usage: rule <COLLECTION> <RULE> <TARGET_COLLECTION>");
        } else {
          const collection = args.shift()!;
          const targetCollection = args.pop()!;
          const rule = args.join(" ");
          await addRule(collection, rule, targetCollection);
        }
        break;
      case "rules":
        if (args.length !== 1) {
          console.log("Usage: rules <COLLECTION>");
        } else {
          await listRules(args[0]);
        }
        break;
      case "delete-rule":
        if (args.length !== 1) {
          console.log("Usage: delete-rule <RULE_ID>");
        } else {
          await deleteRule(parseInt(args[0]));
        }
        break;
      case "apply-rules":
        if (args.length < 1 || args.length > 2) {
          console.log("Usage: apply-rules <COLLECTION> [RULE_ID]");
        } else {
          const collection = args[0];
          const ruleId = args[1] ? parseInt(args[1]) : undefined;
          await applyRules(collection, ruleId);
        }
        break;
      case "chat":
        if (args.length < 1) {
          console.log("Usage: chat <COLLECTION1> [COLLECTION2 ...]");
        } else {
          await startChat(args);
        }
        break;
      default:
        console.log("Unknown command. Available commands:");
        console.log("  clip <URL> <COLLECTION>");
        console.log("  collections");
        console.log("  items <COLLECTION>");
        console.log("  add <ITEM_ID> <COLLECTION>");
        console.log("  remove <ITEM_ID> <COLLECTION>");
        console.log("  delete-collection <COLLECTION>");
        console.log("  exit");
    }
  }
}

if (import.meta.main) {
  main();
}
