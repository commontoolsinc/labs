import { html, type View } from "@commontools/common-html";
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
} from "@commontools/common-builder";
import { type Gem, openSaga } from "../data.js";
import {
  run,
  gemById,
  getCellReferenceOrValue,
} from "@commontools/common-runner";
import { suggestions } from "../suggestions.js";

const MINIMUM_CONFIDENCE = -1.0;

type GemInfo = { id: number; name: string; type: string };

// Lifted functions at module scope
const getGemInfo = lift(({ gems }) => {
  const gemInfo: GemInfo[] = [];
  for (let i = 0; i < gems.length; i++) {
    gemInfo.push({
      id: Number(gems[i][ID]),
      name: String(gems[i][NAME] ?? "unknown"),
      type: String(gems[i][TYPE]),
    });
  }
  return gemInfo;
});

const buildPrompt = lift(
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
);

const filterMatchingGems = lift<{
  matchedIndices: { index: number; confidence: number }[];
  gemInfo: GemInfo[];
}>(
  ({ matchedIndices, gemInfo }) =>
    (matchedIndices ?? [])
      .filter((item) => item.confidence > MINIMUM_CONFIDENCE)
      .map((item) => gemInfo.find((gem) => gem.id === item.index))
      .filter((gem) => gem !== undefined)
      .filter((gem) => gem.id !== 0) // TODO: HACK - ignore first todo list
);

const findSuggestion = lift<{
  matchingGems: GemInfo[];
  data: { [key: string]: any };
}>(({ matchingGems, data }) => {
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
    const bindings = Object.entries(suggestion.dataGems).map(([key, type]) => [
      key,
      matchingGems.find((gem) => gem.type === type),
    ]) as [string, { id: number; name: string; type: string }][];

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
});

const buildSuggestionsList = lift(({ suggestion }) => {
  if (suggestion) {
    return [{ id: 1, title: suggestion.description }];
  }
  return [];
});

const acceptSuggestion = handler<
  {},
  {
    acceptedSuggestion: View | undefined;
    suggestion: any;
    data: { [key: string]: any };
    target: number;
  }
>((_, state) => {
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
  if (target == -1) {
    openSaga(accepted.get()[ID]);
    state.acceptedSuggestion = html`<div></div>`;
  } else {
    state.acceptedSuggestion = accepted.asSimpleCell().get()[UI];
  }
});

export const annotation = recipe<{
  query: string;
  target: number;
  data: { [key: string]: any };
  gems: Gem[];
}>("annotation", ({ query, target, data, gems }) => {
  const gemInfo = getGemInfo({ gems });
  const { result: matchedIndices } = generateData<
    { index: number; confidence: number }[]
  >({
    prompt: buildPrompt({ query, gemInfo }),
    system:
      "You are an assistant that helps match user queries to relevant data gems based on their names and types.",
  });
  const matchingGems = filterMatchingGems({ matchedIndices, gemInfo });
  const suggestion = findSuggestion({ matchingGems, data });

  // Will be populated by acceptSuggestion
  const acceptedSuggestion = cell<View | undefined>(undefined);

  return {
    [UI]: html`<div>
      ${ifElse(
        acceptedSuggestion,
        html`<div>${acceptedSuggestion}</div>`,
        html`<common-suggestions
          suggestions=${buildSuggestionsList({ suggestion })}
          onselect-suggestion=${acceptSuggestion({
            acceptedSuggestion,
            suggestion,
            data,
            target,
          })}
        />`
      )}
    </div>`,
  };
});
