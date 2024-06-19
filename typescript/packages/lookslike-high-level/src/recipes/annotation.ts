import { view, tags } from "@commontools/common-ui";
import { signal, stream } from "@commontools/common-frp";
import { dataGems, keywords } from "../data.js";
import {
  recipe,
  Recipe,
  Gem,
  TYPE,
  suggestions,
  type Suggestion,
} from "../recipe.js";
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
  const suggestion = computed(
    [dataGems, suggestions, query],
    (dataGems, suggestions, query: string) =>
      findSuggestion(dataGems, suggestions, query, Object.keys(data))
  );

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
          button({ "@click": binding("acceptSuggestion") }, [
            suggestion.description,
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

type Result = {
  recipe: Recipe;
  description: string;
  boundGems: { [key: string]: Gem };
};

function findSuggestion(
  dataGems: { [key: string]: Gem },
  suggestions: Suggestion[],
  query: string,
  data: string[]
): Result | undefined {
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

  const gems = Object.entries(dataGems).filter(
    ([name]) => words.includes(name) || aliases.includes(name)
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
        gems.find(([_, gem]) => gem[TYPE] === type)
      ) &&
      Object.values(suggestion.bindings).every((binding) =>
        data.includes(binding)
      )
  );

  console.log("suggestion", suggestion, suggestions);

  if (suggestion) {
    const bindings = Object.entries(suggestion.dataGems).map(([key, type]) => [
      key,
      gems.find(([_, gem]) => gem[TYPE] === type)!,
    ]);

    const nameBindings = Object.fromEntries(
      bindings.map(([key, [name, _gem]]) => [key, name])
    );
    const gemBindings = Object.fromEntries(
      bindings.map(([key, [_name, gem]]) => [key, gem])
    );
    const description = suggestion.description
      .map((part, i) => (i % 2 === 0 ? part : nameBindings[part]))
      .join("");

    return { recipe: suggestion.recipe, description, boundGems: gemBindings };
  } else {
    return undefined;
  }
}
