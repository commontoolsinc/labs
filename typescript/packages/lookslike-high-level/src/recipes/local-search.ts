import { view, tags } from "@commontools/common-ui";
import { signal, stream } from "@commontools/common-frp";
import { recipe, NAME } from "../recipe.js";
const { binding, repeat } = view;
const { vstack, hstack, div, commonInput, button } = tags;
const { state, computed } = signal;
const { subject } = stream;

export const localSearch = recipe("local search", ({ query, location }) => {
  // Initial search
  const results = state(performLocalSearch(query.get(), location.get()));

  const search = subject<any>();

  search.sink({
    send: () => {
      const q = query.get();
      const l = location.get();
      console.log("searching...", [q, l]);
      if (!q || !l) return;
      results.send(performLocalSearch(q, l));
    },
  });

  return {
    UI: [
      vstack({}, [
        hstack({}, [
          vstack({}, [
            "What",
            commonInput({
              value: query,
              placeholder: "Type of place",
              "@common-input#value": query,
            }),
          ]),
          vstack({}, [
            "Where",
            commonInput({
              value: location,
              placeholder: "Location",
              "@common-input#value": location,
            }),
          ]),
        ]),
        button(
          {
            "@click": search,
          },
          ["Search"]
        ),
        vstack(
          {},
          repeat(
            results,
            vstack({}, [
              div({}, binding("name")),
              div({}, binding("description")),
            ])
          )
        ),
      ]),
      {},
    ],
    query,
    location,
    results,
    [NAME]: computed(
      [query, location],
      (query: string, location: string) => `${query} in ${location}`
    ),
  };
});

function performLocalSearch(query: string, location: string) {
  return [
    { name: "Result 1", description: "Description 1" },
    { name: "Result 2", description: "Description 2" },
  ];
}
