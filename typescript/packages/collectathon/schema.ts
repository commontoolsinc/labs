import { CoreMessage } from "npm:ai@3.3.21";
import { fastCompletion } from "./llm.ts";

export async function extractJsonShape(items: any[]): Promise<string> {
  const systemPrompt =
    "Output a json schema that covers all the keys and values of the JSON objects.";
  const userMessage = `${JSON.stringify(items, null, 2)}`;

  const messages: CoreMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];

  const response = await fastCompletion(systemPrompt, messages);
  return response;
}
