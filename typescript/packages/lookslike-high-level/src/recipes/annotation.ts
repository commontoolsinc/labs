import { html } from "@commontools/common-html";
import {
  recipe,
  lift,
  handler,
  cell,
  UI,
  ID,
  NAME,
  TYPE,
  ifElse,
  generateData,
  Recipe,
} from "../builder/index.js";
import { type Gem, openSaga } from "../data.js";
import { run, gemById, getCellReferenceOrValue } from "../runner/index.js";
import { suggestions } from "../suggestions.js";

const MINIMUM_CONFIDENCE = -1.0;

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

export const annotation = recipe<{
  query: string;
  target: number;
  data: { [key: string]: any };
  gems: Gem[];
}>("annotation", ({ query, target, data, gems }) => {
  type GemInfo = {
    id: number;
    name: string;
    type: string;
  };

  const gemInfo = lift(({ gems }) => {
    const gemInfo: GemInfo[] = [];
    for (let i = 0; i < gems.length; i++) {
      gemInfo.push({
        id: Number(gems[i][ID]),
        name: String(gems[i][NAME] ?? "unknown"),
        type: String(gems[i][TYPE]),
      } satisfies GemInfo);
    }
    return gemInfo;
  })({ gems });

  const prompt = lift(
    ({ query, gemInfo }) =>
      `Given the following user query and list of data gems, return the indices of the gems that are most relevant to the query.
Consider both the names and types of the gems when making your selection.
Think broadly, e.g. a stay in a hotel could match a gem called "morning routine", as the user would want to pick a hotel that supports their morning routine.

User query: "${query}"

Data:
${JSON.stringify(gemInfo, null, 2)}

Respond with only JSON array of suggestions, e.g.

\`\`\`json
[{ index: 0, chosen: "work todo list", confidence: 0.9, reason: "the use of the "work projects" implies the user might want a connection to work TODOs" }, { index: 2, chosen: "hobby projects", confidence: 0.5, reason: "projects could be referring to personal projects, hard to tell from context" }, { index: 5, chosen: "suzy collab", reason: "could this be related to Susan? she appears in several project related lists", confidence: 0.33 }]
\`\`\`

notalk;justgo
`
  )({ query, gemInfo });

  const { result: matchedIndices } = generateData<
    { index: number; confidence: number }[]
  >({
    prompt,
    system:
      "You are an assistant that helps match user queries to relevant data gems based on their names and types.",
  });

  const matchingGems = lift<
    {
      matchedIndices: { index: number; confidence: number }[];
      gemInfo: GemInfo[];
    },
    GemInfo[]
  >(
    ({ matchedIndices, gemInfo }) =>
      (matchedIndices ?? [])
        .filter((item) => item.confidence > MINIMUM_CONFIDENCE)
        .map((item) => gemInfo.find((gem) => gem.id === item.index))
        .filter((gem) => gem !== undefined)
        .filter((gem) => gem.id !== 0) // TODO: HACK - ignore first todo list
  )({ matchedIndices, gemInfo });

  const suggestion = lift<
    {
      matchingGems: GemInfo[];
      data: { [key: string]: any };
    },
    | {
        recipe: Recipe;
        description: string;
        bindings: { [key: string]: string };
        boundGems: { [k: string]: number };
      }
    | undefined
  >(({ matchingGems, data }) => {
    const suggestion = suggestions.find(
      (suggestion) =>
        Object.values(suggestion.dataGems ?? {}).every((type) =>
          matchingGems.find((gem) => gem.type === type)
        ) &&
        Object.values(suggestion.bindings ?? {}).every((binding) =>
          Object.keys(data ?? {}).includes(binding)
        )
    );

    if (suggestion) {
      const bindings = Object.entries(suggestion.dataGems).map(
        ([key, type]) => [key, matchingGems.find((gem) => gem.type === type)]
      ) as [string, GemInfo][];

      const nameBindings = Object.fromEntries(
        bindings.map(([key, gem]) => [key, gem.name])
      );
      const gemBindings = Object.fromEntries(
        bindings.map(([key, gem]) => [key, gem.id])
      );

      const description = suggestion.description
        .map((part, i) => (i % 2 === 0 ? part : nameBindings[part]))
        .join("");

      return {
        recipe: suggestion.recipe,
        description,
        bindings: suggestion.bindings,
        boundGems: gemBindings,
      };
    } else {
      return undefined;
    }
  })({ matchingGems, data });

  const suggestionsList = lift(({ suggestion }) => {
    if (suggestion) {
      return [{ id: 1, title: suggestion.description }];
    }
    return [];
  })({ suggestion });

  const acceptedSuggestion = cell<any | undefined>(undefined);
  const acceptSuggestion = handler(
    { acceptedSuggestion, suggestion, data, target },
    (_, state) => {
      const { suggestion, data, target } = state;

      const acceptedRecipe = suggestion.recipe;

      const accepted = run<any, Gem>(acceptedRecipe, {
        ...Object.fromEntries(
          Object.entries(suggestion.bindings as { [key: string]: string }).map(
            ([key, value]) => [key, getCellReferenceOrValue(data[value])]
          )
        ),
        ...Object.fromEntries(
          Object.entries(suggestion.boundGems).map(([key, value]) => [
            key,
            gemById.get(value as number),
          ])
        ),
      });

      // HACK: -1 is home screen and so let's open a new tab
      if (target == -1) openSaga(accepted.get()[ID]);

      // TODO: Use .value here once supported
      state.acceptedSuggestion = accepted.asSimpleCell().get()[UI];
    }
  );

  return {
    [UI]: html`<div>
      ${ifElse(
        acceptedSuggestion,
        html`<div>${acceptedSuggestion}</div>`,
        ifElse(
          suggestion,
          html`<common-suggestions
            suggestions=${suggestionsList}
            onselect-suggestion=${acceptSuggestion}
          />`,
          ""
        )
      )}
    </div>`,
    /*    [UI]: html`<div>
      <common-suggestions suggestions=${suggestionsList} />
    </div>`,*/
  };
});
