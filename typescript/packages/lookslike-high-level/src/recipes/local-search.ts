import { html } from "@commontools/common-html";
import {
  recipe,
  apply,
  handler,
  cell,
  generateData,
  UI,
  NAME,
} from "../builder/index.js";

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

export const localSearch = recipe<{
  what: string;
  where: string;
}>("local search", ({ what, where }) => {
  const query = cell({
    prompt: "",
  });

  const search = handler<
    {},
    { what: string; where: string; query: { prompt: string } }
  >({ what, where, query }, (_, { what, where, query }) => {
    query.prompt = `generate 10 places that match they query: ${what} in ${where}`;
  });

  const { result: places } = generateData<Place[]>({
    prompt: query.prompt,
    result: [],
    schema: {
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
    },
  });

  return {
    [UI]: html`
      <vstack gap="sm">
        <hstack gap="sm">
          <vstack gap="xs">
            <div>What</div>
            <common-input
              value=${what}
              placeholder="Type of place"
              @common-input#value=${what}
            ></common-input>
          </vstack>
          <vstack gap="xs">
            <div>Where</div>
            <common-input
              value=${where}
              placeholder="Location"
              @common-input#value=${where}
            ></common-input>
          </vstack>
        </hstack>
        <button @click=${search}>Search</button>
        <vstack gap="md">
          ${places.map(
            (place) => html`
              <vstack gap="xs">
                <div>${place.name}</div>
                <div>${place.description}</div>
                <div>${place.address}</div>
                <div>${place.city}, ${place.state} ${place.zip}</div>
                <div>${"*****".slice(0, place.rating)}</div>
              </vstack>
            `
          )}
        </vstack>
      </vstack>
    `,
    query,
    location,
    places,
    [NAME]: apply(
      { query, location },
      (query, location) => `${query || "all"} in ${location || "anywhere"}`
    ),
  };
});
