import { db } from "./db.ts";
import { chat } from "./llm.ts";
import { CoreMessage } from "npm:ai@3.3.21";

export async function handleActionCommand(
  collectionName: string,
  userPrompt: string,
) {
  // Fetch the collection items
  const items = db.query<[number, string]>(
    `SELECT i.id, i.content
     FROM items i
     JOIN item_collections ic ON i.id = ic.item_id
     JOIN collections c ON ic.collection_id = c.id
     WHERE c.name = ?`,
    [collectionName],
  );

  if (items.length === 0) {
    console.log(`No items found in collection: ${collectionName}`);
    return;
  }

  // Parse the JSON content of each item
  const jsonItems = items.map(([id, content]) => ({
    id,
    ...JSON.parse(content),
  }));

  console.log(jsonItems);

  // Extract the shape of the JSON items
  const itemShape = extractJsonShape(jsonItems[0]);

  console.log("Items shape:", itemShape);

  // Generate the transformation function using the LLM
  const transformationFunction = await generateTransformationFunction(
    userPrompt,
    itemShape,
  );

  // Print the function and ask for user confirmation
  console.log("Generated transformation function:");
  console.log(transformationFunction);
  const confirmation = prompt("Do you want to execute this function? (y/n): ");

  if (confirmation.toLowerCase() !== "y") {
    console.log("Function execution cancelled.");
    return;
  }

  // Execute the transformation function
  try {
    const result = eval(
      `(${transformationFunction})(${JSON.stringify(jsonItems)})`,
    );
    console.log("Transformation result:");
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error("Error executing transformation function:", error);
  }
}

function extractJsonShape(obj: any): string {
  const shape: { [key: string]: string } = {};
  for (const [key, value] of Object.entries(obj)) {
    shape[key] = typeof value;
  }
  return JSON.stringify(shape, null, 2);
}

async function generateTransformationFunction(
  userPrompt: string,
  itemShape: string,
): Promise<string> {
  const systemPrompt =
    "You are an expert JavaScript programmer. Generate a JavaScript function that takes an array of JSON objects as input and transforms it based on the user's prompt. The function should return the transformed data.";
  const userMessage = `Generate a JavaScript function to perform the following transformation on an array of JSON objects: ${userPrompt}\n\nThe function should take a single parameter 'items' which is the array of JSON objects. The shape of each item is:\n${itemShape}\n\nReturn only the function, without any explanation or additional text.

    e.g.

    function(items) {
      ...
    }`;

  const messages: CoreMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];

  const response = await chat(systemPrompt, messages, true);
  return `${response}`;
}

export function addActionCommand(args: string[]) {
  if (args.length < 2) {
    console.log("Usage: action <COLLECTION> <PROMPT>");
    return;
  }

  const collectionName = args.shift()!;
  const prompt = args.join(" ");
  handleActionCommand(collectionName, prompt);
}
