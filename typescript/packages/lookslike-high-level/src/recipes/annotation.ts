import { view, tags } from "@commontools/common-ui";
import { signal, stream } from "@commontools/common-frp";
import { LLMClient } from "@commontools/llm-client";
import { dataGems } from "../data.js";
import {
  recipe,
  Recipe,
  Gem,
  TYPE,
  NAME,
  suggestions,
  type Suggestion,
} from "../recipe.js";
import { effect } from "@commontools/common-frp/signal";
const { include } = tags;
const { state, computed, isSignal } = signal;
const { subject } = stream;
const { binding } = view;

/**
 * Strategy:
 *
 * The paremeters to suggestion are:
 *  - query: signal.Signal<string> - the query for the suggestion
 *  - data: { key: Signal<any> } - the data available to bind to
 *
 * We'll create a vdom that is the UI and return including it as the vdom for
 * this node. We populate that vdom with suggestions by computing from the
 * query.
 *
 * If a suggestion is accepted, we instantiate the recipe and bind it to the
 * supplied data.
 */

export const annotation = recipe("annotation", ({ "?": query, ...data }) => {
  const suggestion: Signal<Result | undefined> = state(undefined);

  effect([dataGems, query], async (dataGems, query: string) => {
    if (dataGems.length === 0) return;
    const guess = await findSuggestion(
      dataGems,
      suggestions,
      query,
      Object.keys(data),
    );
    suggestion.send(guess);
  });

  const acceptSuggestion = subject<any>();
  const acceptedSuggestion = state<Result | undefined>(undefined);
  acceptSuggestion.sink({
    send: () => {
      acceptedSuggestion.send(suggestion.get());
    },
  });

  const UI = computed(
    [suggestion, acceptedSuggestion],
    (suggestion, acceptedSuggestion) => {
      if (acceptedSuggestion) {
        const acceptedRecipe = acceptedSuggestion.recipe;
        const accepted = acceptedRecipe({
          ...data,
          ...acceptedSuggestion.boundGems,
        });
        return [
          include({ content: binding("acceptedUI") }),
          { acceptedUI: accepted.UI },
        ];
      } else if (suggestion) {
        return [
          tags.suggestions({
            suggestions: [{ id: 1, title: suggestion.description }],
            "@select-suggestion": binding("acceptSuggestion"),
          }),
          { acceptSuggestion },
        ];
      } else {
        return [undefined, {}];
      }
    },
  );

  return { UI };
});

type Result = {
  recipe: Recipe;
  description: string;
  boundGems: { [key: string]: Gem };
};

const client = new LLMClient({
  serverUrl: "http://localhost:8000",
  system:
    "You are an assistant that helps match user queries to relevant data gems based on their names and types.",
  tools: [],
});

async function findSuggestion(
  dataGems: Gem[],
  suggestions: Suggestion[],
  query: string,
  data: string[],
): Promise<Result | undefined> {
  // Use LLM to match query to data gems
  const matchedGems = await matchGemsWithLLM(dataGems, query);

  // The rest of the function remains largely the same
  const suggestion = suggestions.find(
    (suggestion) =>
      Object.values(suggestion.dataGems).every((type) =>
        matchedGems.find((gem) => gem[TYPE] === type),
      ) &&
      Object.values(suggestion.bindings).every((binding) =>
        data.includes(binding),
      ),
  );

  if (suggestion) {
    const bindings = Object.entries(suggestion.dataGems).map(([key, type]) => [
      key,
      matchedGems.find((gem) => gem[TYPE] === type),
    ]) as [[string, Gem]];

    const nameBindings = Object.fromEntries(
      bindings.map(([key, gem]) => [key, getNameFromGem(gem)]),
    );
    const gemBindings = Object.fromEntries(bindings);

    const description = suggestion.description
      .map((part, i) => (i % 2 === 0 ? part : nameBindings[part]))
      .join("");

    return { recipe: suggestion.recipe, description, boundGems: gemBindings };
  } else {
    return undefined;
  }
}

type LLMSuggestion = {
  index: 0;
  chosen: string;
  confidence: number;
  reason: string;
};

async function matchGemsWithLLM(
  dataGems: Gem[],
  query: string,
): Promise<Gem[]> {
  const gemInfo = dataGems.map((gem) => ({
    name: getNameFromGem(gem),
    type: gem[TYPE],
  }));

  if (gemInfo.length == 0) {
    console.warn("No data gems to match with LLM");
    return [];
  }

  const prompt = `
Given the following user query and list of data gems, return the indices of the gems that are most relevant to the query.
Consider both the names and types of the gems when making your selection.

User query: "${query}"

Data gems:
${JSON.stringify(gemInfo, null, 2)}

Respond with only JSON array of suggestions, e.g.

\`\`\`json
[{ index: 0, chosen: "work todo list", confidence: 0.9, reason: "the use of the "work projects" implies the user might want a connection to work TODOs" }, { index: 2, chosen: "hobby projects", confidence: 0.5, reason: "projects could be referring to personal projects, hard to tell from context" }, { index: 5, chosen: "suzy collab", reason: "could this be related to Susan? she appears in several project related lists", confidence: 0.33 }]
\`\`\`

notalk;justgo
`;

  const response = await client.handleConversation(prompt);

  let matchedIndices: LLMSuggestion[] = [];
  try {
    matchedIndices = grabJson(response[response.length - 1]);
    console.log(
      "Suggestion",
      query,
      matchedIndices,
      matchedIndices.map((item) => dataGems[item.index]),
    );
  } catch (error) {
    console.error("Failed to parse LLM response:", error);
    return [];
  }

  return matchedIndices
    .filter((item) => item.confidence > 0.8)
    .map((item) => dataGems[item.index])
    .filter((gem) => gem !== undefined);
}

export function grabJson(txt) {
  return JSON.parse(txt.match(/```json\n([\s\S]+?)```/)[1]);
}

function findSuggestion_old(
  dataGems: Gem[],
  suggestions: Suggestion[],
  query: string,
  data: string[],
): Result | undefined {
  // Step 1: Find candidate data gems by doing a dumb keyword seach
  const terms = queryToTerms(query);

  const gems = dataGems.filter((gem) =>
    queryToTerms(getNameFromGem(gem)).some((term) => terms.includes(term)),
  );

  // Step 2: Find suggestions that bridge matching gems to recipes:
  //  - Binds to the found gem
  //  - Context has all the bindings needed
  //
  // (TODO: It looks like this should be a property of recipes, all the ways it
  // can be useful!)
  const suggestion = suggestions.find(
    (suggestion) =>
      Object.values(suggestion.dataGems).every((type) =>
        gems.find((gem) => gem[TYPE] === type),
      ) &&
      Object.values(suggestion.bindings).every((binding) =>
        data.includes(binding),
      ),
  );

  console.log("suggestion", suggestion, query, gems, suggestions);

  if (suggestion) {
    const bindings = Object.entries(suggestion.dataGems).map(([key, type]) => [
      key,
      gems.find((gem) => gem[TYPE] === type),
    ]) as [[string, Gem]];

    const nameBindings = Object.fromEntries(
      bindings.map(([key, gem]) => [key, getNameFromGem(gem)]),
    );
    const gemBindings = Object.fromEntries(bindings);

    const description = suggestion.description
      .map((part, i) => (i % 2 === 0 ? part : nameBindings[part]))
      .join("");

    return { recipe: suggestion.recipe, description, boundGems: gemBindings };
  } else {
    return undefined;
  }
}

function getNameFromGem(gem: Gem): string {
  return (isSignal(gem[NAME]) ? gem[NAME].get() : gem[NAME]) as string;
}

const keywords: { [key: string]: string[] } = {
  groceries: ["grocery"],
};

function queryToTerms(query: string): string[] {
  const parts: string[] = query
    .toLowerCase()
    .split(/ +/)
    .map((word) => word.trim())
    .filter((word) => word.length > 0);

  const aliases = parts.flatMap((word) => keywords[word] ?? []);

  const words = [...parts, ...aliases].flatMap((word, i) => {
    const w = [word];
    if (i < parts.length - 1) w.push(word + " " + parts[i + 1]);
    if (i < parts.length - 2)
      w.push(word + " " + parts[i + 1] + " " + parts[i + 2]);
    return w;
  });

  return words;
}
