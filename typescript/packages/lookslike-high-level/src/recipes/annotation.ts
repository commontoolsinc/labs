import { view, tags } from "@commontools/common-ui";
import { signal, stream } from "@commontools/common-frp";
import { dataGems, keywords, suggestions, type Suggestion } from "../data.js";
import { recipe, InstantiatedRecipe, TYPE } from "../recipe.js";
const { button, include } = tags;
const { state, computed } = signal;
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
  const suggestion = computed([dataGems, query], (dataGems, query: string) =>
    findSuggestion(dataGems, query, Object.keys(data))
  );
  const suggestionDescription = computed(
    [suggestion],
    (suggestion: [Suggestion, [string, InstantiatedRecipe]]) => {
      if (!suggestion) return undefined;
      const parts = suggestion[0].description;
      const bindings = Object.fromEntries(
        Object.entries(suggestion[0].dataGems).map(([_type, key]) => [
          key,
          suggestion[1][0],
        ])
      );
      if (!parts) return undefined;
      return parts
        .map((part, i) => (i % 2 === 0 ? part : bindings[part]))
        .join("");
    }
  );

  const acceptSuggestion = subject<any>();
  const acceptedSuggestion = state<
    [Suggestion, [string, InstantiatedRecipe]] | undefined
  >(undefined);
  acceptSuggestion.sink({
    send: () => {
      acceptedSuggestion.send(suggestion.get());
    },
  });

  const UI = computed(
    [suggestionDescription, acceptedSuggestion],
    (suggestionDescription, acceptedSuggestion) => {
      if (acceptedSuggestion) {
        const suggestion = acceptedSuggestion[0];
        const acceptedRecipe = suggestion.recipe;
        const gem = acceptedSuggestion[1][1];
        const gemBinding = suggestion.dataGems[gem[TYPE]];
        const accepted = acceptedRecipe({ ...data, [gemBinding]: gem });
        console.log("accepted", accepted);
        return [
          include({ content: binding("acceptedUI") }),
          { acceptedUI: accepted.UI },
        ];
      } else if (suggestionDescription) {
        return [
          button({ "@click": binding("acceptSuggestion") }, [
            suggestionDescription,
          ]),
          { acceptSuggestion },
        ];
      } else {
        return [undefined, {}];
      }
    }
  );

  return { UI };
});

function findSuggestion(
  dataGems: { [key: string]: InstantiatedRecipe },
  query: string,
  data: string[]
): [Suggestion, [string, InstantiatedRecipe]] | undefined {
  // Step 1: Find candidate data gems by doing a dumb keyword seach
  const parts: string[] = query
    .toLowerCase()
    .split(/ +/)
    .map((word) => word.trim())
    .filter((word) => word.length > 0);

  const words = parts.flatMap((word, i) => {
    const w = [word];
    if (i < parts.length - 1) w.push(word + " " + parts[i + 1]);
    if (i < parts.length - 2)
      w.push(word + " " + parts[i + 1] + " " + parts[i + 2]);
    return w;
  });

  const aliases = words.flatMap((word) => keywords[word] ?? []);

  const gem = Object.entries(dataGems).find(
    ([name]) => words.includes(name) || aliases.includes(name)
  );

  console.log(words, aliases, dataGems, "-->", gem);
  if (!gem) return undefined;

  const type = gem[1][TYPE];

  // Step 2: Find suggestions that bridge matching gems to recipes:
  //  - Binds to the found gem
  //  - Context has all the bindings needed
  //
  // (TODO: It looks like this should be a property of recipes, all the ways it
  // can be useful!)
  const suggestion = suggestions.find(
    (suggestion) =>
      type in suggestion.dataGems &&
      Object.values(suggestion.bindings).every((binding) =>
        data.includes(binding)
      )
  );

  console.log("suggestion", suggestion);
  return suggestion ? [suggestion, gem] : undefined;
}
