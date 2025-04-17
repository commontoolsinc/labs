import { generateObject } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";

if (!Deno.env.get("OPENAI_API_KEY")) {
  throw new Error("OPENAI_API_KEY is not set");
}

const model = openai("gpt-4o-mini");

export async function llmVerifyCharm(
  prompt: string,
  filename: string,
): Promise<string> {
  const system = `You are a helpful assistant that verifies charm screenshots.
  
  Your task is to evaluate how well the screenshot represents what the user asked for in the prompt.
  
  If the screenshot accurately represents the prompt, return a PASS result with a brief explanation.
  If the screenshot does not match the prompt, return a FAIL result with a brief explanation of what's missing or incorrect.`;

  const schema = z.object({
    result: z.enum(["PASS", "FAIL"]),
    summary: z.string().describe("A 1-sentence summary of your evaluation"),
  });

  const { object } = await generateObject({
    system: system,
    model,
    schema,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: prompt,
          },
          { type: "image", image: Deno.readFileSync(filename) },
        ],
      },
    ],
  });

  const result = schema.parse(object);
  console.log({ result });
  return JSON.stringify(result);
}
