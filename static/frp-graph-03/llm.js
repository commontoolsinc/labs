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

export function grabViewTemplate(txt) {
  return txt.match(/```vue\n([\s\S]+?)```/)[1];
}

export function extractResponse(data) {
  return data.choices[0].message.content;
}
// const name = Name();
// const race = Race();
// const age = Age();

export const uiPrompt = `Your task is to generate user interfaces using a vue compatible format. Here is an example component + state combo:

  \`\`\`vue
  <div>
    <label for="name">Age:</label>
    <input type="number" v-model="age" />
  </div>
  \`\`\

  Extend this pattern, preferring simple unstyled html. Do not include a template tag, surround all components in a div.
  `;
