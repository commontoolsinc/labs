import { view, tags } from "@commontools/common-ui";
import { signal, stream } from "@commontools/common-frp";
import { generateData } from "@commontools/llm-client";
import { recipe, NAME } from "../recipe.js";
import { mockResultClient } from "../llm-client.js";
const { binding, repeat } = view;
const { vstack, hstack, div, commonInput, button } = tags;
const { state, computed } = signal;
const { subject } = stream;

export interface Place {
  name: string;
  description: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  latitude: number;
  longitude: number;
  rating: number;
}

export const localSearch = recipe("local search", ({ query, location }) => {
  // Initial search
  const places = state<Place[]>([]);
  performLocalSearch(query.get(), location.get()).then((results) =>
    places.send(results)
  );

  const search = subject<any>();
  search.sink({
    send: () =>
      performLocalSearch(query.get(), location.get()).then((results) =>
        places.send(results)
      ),
  });

  const summaries = computed([places], (places: Place[]) =>
    places.map((place) => ({
      name: place.name,
      description: place.description,
      address: place.address,
      city: place.city + ", " + place.state + " " + place.zip,
      rating: "*****".slice(0, place.rating),
    }))
  );

  return {
    UI: vstack({}, [
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
      button({ "@click": search }, ["Search"]),
      vstack(
        {},
        repeat(
          summaries,
          vstack({}, [
            div({}, binding("name")),
            div({}, binding("description")),
            div({}, binding("imageUrl")),
            div({}, binding("address")),
            div({}, binding("city")),
            div({}, binding("rating")),
          ])
        )
      ),
    ]),
    query,
    location,
    places,
    [NAME]: computed(
      [query, location],
      (query: string, location: string) =>
        `${query || "all"} in ${location || "anywhere"}`
    ),
  };
});

async function performLocalSearch(
  query: string,
  location: string
): Promise<Place[]> {
  if (!query || !location) return [];
  const result = await generateData(
    mockResultClient,
    `generate 10 places that match they query: ${query} in ${location}`,
    [],
    {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          address: { type: "string" },
          city: { type: "string" },
          state: { type: "string" },
          zip: { type: "string" },
          latitude: { type: "number" },
          longitude: { type: "number" },
          rating: { type: "number", minimum: 0, maximum: 5 },
        },
      },
    }
  );
  return result as Place[];
}
