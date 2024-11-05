import {
  UI,
  NAME,
  lift,
  recipe,
  handler,
  derive,
  Opaque,
  OpaqueRef,
} from "@commontools/common-builder";
import { richTextEditor } from "@commontools/common-os-ui";

import z from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { h } from "@commontools/common-html";
import { llm } from "@commontools/common-builder";

const Cookware = z.object({
  name: z.string().describe("Name of the cookware"),
});

const Metadata = z.object({
  course: z.string().describe("Course of the meal"),
  time: z.number().describe("Time to prepare the meal"),
  source: z.string().describe("Source of the recipe"),
});

const Ingredient = z.object({
  name: z.string().describe("Name of the ingredient"),
  quantity: z.string().describe("Quantity of the ingredient"),
});

const Meal = z
  .object({
    name: z.string().describe("Name of the meal"),
    ingredients: Ingredient.array().describe("Ingredients needed for the meal"),
    cookware: Cookware.array().describe("Cookware needed for the meal"),
    metadata: Metadata.describe("Metadata of the meal"),
    pictures: z.string().array().describe("Pictures of the meal"),
    instructions: z.string().describe("Instructions to prepare the meal"),
  })
  .describe("Receipe for a meal");

const Model = z.object({
  meals: Meal.array().describe("Meals to plan"),
  prompt: z.string().describe("Prompt").default(""),
  detail: z.any().describe("Editor").default({}),
});

const feedback = <Feedback extends {}>(inputs: Opaque<Feedback>) =>
  handler<Feedback, Feedback>((message, state) => {
    for (const [key, value] of Object.entries(message)) {
      state[key as keyof Feedback] = value as Feedback[keyof Feedback];
    }
  })(inputs);

const instructions = `
  You are a world class chef! You will be assisting me to plan a meal. I will ask you to help me with a cooking potentially provide recepie instructions and you will help me to parse it and arrive to specific instructions in the following format:

  ${JSON.stringify(zodToJsonSchema(Meal))}
`;

export const mealExample = recipe(Model, (state) => {
  const text = derive(state.prompt, (prompt) =>
    prompt != "" ? prompt.toUpperCase() : "Nothing here yet",
  );

  const request = derive(state.prompt, (prompt) =>
    prompt != "" ? { prompt, system: instructions } : {},
  );

  derive(state.detail, ($) => console.log($.toString()));

  const response = llm(request);
  return {
    [NAME]: "Meals",
    [UI]: (
      <os-container>
        <pre>{text}</pre>
        <p>{derive(response, ({ partial }) => partial ?? "")}</p>
        {/* <os-rich-text-editor
          oninput={feedback({ detail: state.detail })}
        ></os-rich-text-editor> */}
      </os-container>
    ),
    data: state.prompt,

    schema: zodToJsonSchema(Meal),

    addToPrompt: feedback({ prompt: state.prompt }),
  };
});
