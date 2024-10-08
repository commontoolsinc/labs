import { html } from "@commontools/common-html";
import {
  recipe,
  handler,
  lift,
  str,
  cell,
  llm,
  UI,
  NAME,
  ifElse,
} from "@commontools/common-builder";
import { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';

const Place = z.object({
  name: z.string(),
  description: z.string(),
  address: z.string(),
  city: z.string(),
  state: z.string(),
  zip: z.string(),
  latitude: z.number(),
  longitude: z.number(),
  rating: z.number().min(0).max(5),
});

type Place = z.infer<typeof Place>;

const PlaceList = z.array(Place);
type PlaceList = z.infer<typeof PlaceList>;

const jsonSchema = JSON.stringify(zodToJsonSchema(PlaceList), null, 2);

const buildPrompt = lift<{ prompt?: string }, { messages: string[], system: string, stop?: string }>(({ prompt }) => {
  if (!prompt) {
    return {};
  }
  return {
    messages: [prompt, '```json\n['],
    system: `Generate place data inspired by the user description using JSON:\n\n<schema>${jsonSchema}</schema>`,
    stop: '```'
  }
});

const grabJson = lift<{ result?: string }, PlaceList | undefined>(({ result }) => {
  if (!result) {
    return [];
  }
  const jsonMatch = result.match(/```json\n([\s\S]+?)```/);
  if (!jsonMatch) {
    console.error("No JSON found in text:", result);
    return [];
  }
  let rawData = JSON.parse(jsonMatch[1]);
  let parsedData = PlaceList.safeParse(rawData);
  if (!parsedData.success) {
    console.error("Invalid JSON:", parsedData.error);
    return [];
  }
  return parsedData.data;
});

const searchPlaces = handler<
  {},
  { what: string; where: string; prompt: string }
>((_, state) => {
  state.prompt = `generate 10 places that match they query: ${state.what} in ${state.where}`;
});

const updateValue = handler<{ detail: { value: string } }, { value: string }>(
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

  const prompt = cell<string | undefined>(undefined);

  const { result, pending } = llm(buildPrompt({prompt}))
  const places = grabJson({ result });

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
        <common-button onclick=${searchPlaces({ what, where, prompt })}
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
