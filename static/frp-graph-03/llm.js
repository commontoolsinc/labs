import Instructor from "https://cdn.jsdelivr.net/npm/@instructor-ai/instructor@1.2.1/+esm";
import OpenAI from "https://cdn.jsdelivr.net/npm/openai@4.40.1/+esm";
import { fetchApiKey } from "./apiKey.js";

const apiKey = fetchApiKey();

const openai = new OpenAI({
  apiKey: apiKey,
  dangerouslyAllowBrowser: true,
});

let model = "gpt-4o";
// let model = "gpt-4-turbo-preview";
export const client = Instructor({
  client: openai,
  mode: "JSON",
});

export async function doLLM(input, system, response_model) {
  try {
    return await client.chat.completions.create({
      messages: [
        { role: "system", content: system },
        { role: "user", content: input },
      ],
      model,
    });
  } catch (error) {
    console.error("Error analyzing text:", error);
  }
}
