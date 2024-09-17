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
import { type Charm, openCharm } from "../data.js";
import {
  run,
  charmById,
  getCellReferenceOrValue,
} from "@commontools/common-runner";
import { suggestions } from "../suggestions.js";

const MINIMUM_CONFIDENCE = -1.0;

type CharmInfo = { id: number; name: string; type: string };

// Lifted functions at module scope
const getCharmInfo = lift(({ charms }) => {
  const charmInfo: CharmInfo[] = [];
  for (let i = 0; i < charms.length; i++) {
    charmInfo.push({
      id: Number(charms[i][ID]),
      name: String(charms[i][NAME] ?? "unknown"),
      type: String(charms[i][TYPE]),
    });
  }
  return charmInfo;
});

const buildPrompt = lift(
  ({ query, charmInfo }) =>
    `Given the following user query and list of data charms, return the indices of the charms that are most relevant to the query.
Consider both the names and types of the charms when making your selection.
Think broadly, e.g. a stay in a hotel could match a charm called "morning routine", as the user would want to pick a hotel that supports their morning routine.

User query: "${query}"

Data:
${JSON.stringify(charmInfo, null, 2)}

Respond with only JSON array of suggestions, e.g.

\`\`\`json
[{ index: 0, chosen: "work todo list", confidence: 0.9, reason: "the use of the "work projects" implies the user might want a connection to work TODOs" }, { index: 2, chosen: "hobby projects", confidence: 0.5, reason: "projects could be referring to personal projects, hard to tell from context" }, { index: 5, chosen: "suzy collab", reason: "could this be related to Susan? she appears in several project related lists", confidence: 0.33 }]
\`\`\`

notalk;justgo
`
);

const filterMatchingCharms = lift<{
  matchedIndices: { index: number; confidence: number }[];
  charmInfo: CharmInfo[];
}>(
  ({ matchedIndices, charmInfo }) =>
    (matchedIndices ?? [])
      .filter((item) => item.confidence > MINIMUM_CONFIDENCE)
      .map((item) => charmInfo.find((charm) => charm.id === item.index))
      .filter((charm) => charm !== undefined)
      .filter((charm) => charm.id !== 0) // TODO: HACK - ignore first todo list
);

const findSuggestion = lift<{
  matchingCharms: CharmInfo[];
  data: { [key: string]: any };
}>(({ matchingCharms, data }) => {
  const suggestion = suggestions.find(
    (suggestion) =>
      Object.values(suggestion.charms ?? {}).every((type) =>
        matchingCharms.find((charm) => charm.type === type)
      ) &&
      Object.values(suggestion.bindings ?? {}).every((binding) =>
        Object.keys(data ?? {}).includes(binding)
      )
  );

  if (suggestion) {
    const bindings = Object.entries(suggestion.charms).map(([key, type]) => [
      key,
      matchingCharms.find((charm) => charm.type === type),
    ]) as [string, { id: number; name: string; type: string }][];

    const nameBindings = Object.fromEntries(
      bindings.map(([key, charm]) => [key, charm.name])
    );
    const charmBindings = Object.fromEntries(
      bindings.map(([key, charm]) => [key, charm.id])
    );

    const description = suggestion.description
      .map((part, i) => (i % 2 === 0 ? part : nameBindings[part]))
      .join("");

    return {
      recipe: suggestion.recipe,
      description,
      bindings: suggestion.bindings,
      boundCharms: charmBindings,
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

  const accepted = run<any, Charm>(acceptedRecipe, {
    ...Object.fromEntries(
      Object.entries(suggestion.bindings as { [key: string]: string }).map(
        ([key, value]) => [key, getCellReferenceOrValue(data[value])]
      )
    ),
    ...Object.fromEntries(
      Object.entries(suggestion.boundCharms).map(([key, value]) => [
        key,
        charmById.get(value as number),
      ])
    ),
  });

  // HACK: -1 is home screen and so let's open a new tab
  if (target == -1) {
    openCharm(accepted.get()[ID]);
    state.acceptedSuggestion = html`<div></div>`;
  } else {
    state.acceptedSuggestion = accepted.asSimpleCell().get()[UI];
  }
});

export const annotation = recipe<{
  query: string;
  target: number;
  data: { [key: string]: any };
  charms: Charm[];
}>("annotation", ({ query, target, data, charms }) => {
  const charmInfo = getCharmInfo({ charms });
  const { result: matchedIndices } = generateData<
    { index: number; confidence: number }[]
  >({
    prompt: buildPrompt({ query, charmInfo }),
    system:
      "You are an assistant that helps match user queries to relevant data charms based on their names and types.",
  });
  const matchingCharms = filterMatchingCharms({ matchedIndices, charmInfo });
  const suggestion = findSuggestion({ matchingCharms, data });

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
