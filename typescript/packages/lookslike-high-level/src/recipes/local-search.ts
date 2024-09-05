import { html } from "@commontools/common-html";
import {
  recipe,
  apply,
  handler,
  cell,
  generateData,
  UI,
  NAME,
  ifElse,
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
  what.setDefault("restaurants");
  // TODO: This should be the user's default location, not hardcoded
  where.setDefault("San Francisco");

  const query = cell({
    prompt: "",
  });

  const search = handler<
    {},
    { what: string; where: string; query: { prompt: string } }
  >({ what, where, query }, (_, { what, where, query }) => {
    query.prompt = `generate 10 places that match they query: ${what} in ${where}`;
  });

  const { pending, result: places } = generateData<Place[]>({
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
      <common-vstack gap="sm">
        <common-hstack gap="sm">
          <common-vstack gap="xs">
            <div>What</div>
            <common-input
              value=${what}
              placeholder="Type of place"
              @common-input#value=${what}
            ></common-input>
          </common-vstack>
          <common-vstack gap="xs">
            <div>Where</div>
            <common-input
              value=${where}
              placeholder="Location"
              @common-input#value=${where}
            ></common-input>
          </common-vstack>
        </common-hstack>
        <common-button onclick=${search}>Search</common-button>
        <common-vstack gap="md">
          ${ifElse(
            pending,
            html`<div>Loading...</div>`,
            places.map(
              (place) => html`
                <common-vstack gap="xs">
                  <div>${place.name}</div>
                  <div>${place.description}</div>
                  <div>${place.address}</div>
                  <div>${place.city}, ${place.state} ${place.zip}</div>
                  <div>${"*****".slice(0, place.rating)}</div>
                </common-vstack>
              `
            )
          )}
        </common-vstack>
      </common-vstack>
    `,
    what,
    where,
    places,
    [NAME]: apply(
      { what, where },
      ({ what, where }) => `${what || "all"} in ${where || "anywhere"}`
    ),
  };
});
