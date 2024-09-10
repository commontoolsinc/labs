import { html } from "@commontools/common-html";
import {
  recipe,
  asHandler,
  lift,
  str,
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

const searchPlaces = asHandler<
  {},
  { what: string; where: string; query: { prompt: string } }
>((_, { what, where, query }) => {
  query.prompt = `generate 10 places that match they query: ${what} in ${where}`;
});

const updateValue = asHandler<{ detail: { value: string } }, { value: string }>(
  ({ detail }, state) => detail?.value && (state.value = detail.value)
);

const asStars = lift((rating: number) => "⭐".repeat(Math.round(rating)));

export const localSearch = recipe<{
  what: string;
  where: string;
}>("local search", ({ what, where }) => {
  what.setDefault("restaurants");
  // TODO: This should be the user's default location, not hardcoded
  where.setDefault("San Francisco");

  const query = cell({
    prompt: undefined,
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

  const { pending, result: places } = generateData<Place[]>(query);

  return {
    [UI]: html`
      <common-vstack gap="sm">
        <common-hstack gap="sm">
          <common-vstack gap="xs">
            <div>What</div>
            <common-input
              value=${what}
              placeholder="Type of place"
              oncommon-input=${updateValue({ value: what })}
            ></common-input>
          </common-vstack>
          <common-vstack gap="xs">
            <div>Where</div>
            <common-input
              value=${where}
              placeholder="Location"
              oncommon-input=${updateValue({ value: where })}
            ></common-input>
          </common-vstack>
        </common-hstack>
        <common-button onclick=${searchPlaces({ what, where, query })}
          >Search</common-button
        >
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
                  <div>${asStars(place.rating)}</div>
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
    [NAME]: str`${what} in ${where}`,
  };
});
