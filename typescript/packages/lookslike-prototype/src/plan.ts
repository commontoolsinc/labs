import { ChatCompletionMessageParam } from "openai/resources/index.mjs";
import { client, model } from "./llm.js";

type Conversation = ChatCompletionMessageParam[];

export async function plan(userInput: string, steps: string[]) {
  if (steps.length === 0) {
    console.warn("No steps in plan");
    return;
  }

  console.log(`[${userInput}] plan`, steps);

  let messages: ChatCompletionMessageParam[] = [
    { role: "system", content: steps[0] },
    { role: "user", content: steps[1] }
  ];

  let msgIdx = 1;

  let running = true;
  while (running) {
    const response = await client.chat.completions.create({
      messages,
      model,
      temperature: 0
    });

    const latest = response.choices[0].message;
    console.log(`[${userInput}] response`, latest);
    messages.push(latest);

    if (msgIdx >= steps.length - 1) {
      running = false;
      break;
    }

    messages.push({ role: "user", content: steps[++msgIdx] });
  }

  suggest(userInput, messages).then((suggestions) => {
    console.log(`[${userInput}] suggestions`, suggestions);
  });

  return messages;
}

export async function suggest(input: string, fullPlan: Conversation) {
  const response = await client.chat.completions.create({
    messages: [
      ...fullPlan,
      {
        role: "user",
        content:
          "Based on the original user request and the plan to service it, suggest 3 similar or related tasks the user might like to explore next. This could include tweaks to the existing UI, reusing the data in another context or a mix of both. Be concise, use a numbered list with no more than 7 words per item."
      }
    ],
    model,
    temperature: 0
  });

  return response.choices[0].message;
}
