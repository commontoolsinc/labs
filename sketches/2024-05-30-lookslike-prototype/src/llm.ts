import Instructor from "@instructor-ai/instructor";
import OpenAI from "openai";
import { fetchApiKey } from "./apiKey";

const apiKey = fetchApiKey() as string

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

export async function generateImage(prompt: string) {
  const response = await openai.images.generate({
    model: "dall-e-3",
    prompt: prompt,
    n: 1,
    size: "1024x1024",
  });
  return response.data[0].url;
}

export async function doLLM(input: string, system: string, response_model: any) {
  try {
    console.log("input", input);
    console.log("system", system);

    return await client.chat.completions.create({
      messages: [
        { role: "system", content: system },
        { role: "user", content: input },
      ],
      model,
    });
  } catch (error) {
    console.error("Error analyzing text:", error);
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
