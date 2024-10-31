import { h } from "@commontools/common-html";
import {
  recipe,
  handler,
  lift,
  str,
  cell,
  llm,
  UI,
  NAME,
} from "@commontools/common-builder";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

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

const imageUrl = lift(
  ({ prompt }) => `/api/img/?prompt=${encodeURIComponent(prompt)}`
);

type Place = z.infer<typeof Place>;

const PlaceList = z.array(Place);
type PlaceList = z.infer<typeof PlaceList>;

const jsonSchema = JSON.stringify(zodToJsonSchema(PlaceList), null, 2);

const buildPrompt = lift<
  { prompt?: string },
  { messages: string[]; system: string; stop?: string }
>(({ prompt }) => {
  if (!prompt) {
    return {};
  }
  return {
    messages: [prompt, "```json\n["],
    model: "claude-3-5-haiku-latest",
    system: `Generate place data inspired by the user description using JSON:\n\n<schema>${jsonSchema}</schema>`,
    stop: "\n```\n",
  };
});

const grabJson = lift<{ result?: string }, PlaceList>(({ result }) => {
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
  { prompt: string; what: string; where: string }
>(({}, state) => {
  state.prompt = `generate 10 places that match they query: ${state.what} in ${state.where}`;
});

const updateValue = handler<{ detail: { value: string } }, { value: string }>(
  ({ detail }, state) => detail?.value && (state.value = detail.value)
);

// TODO: This should be the user's default location, not hardcoded
const Search = z
  .object({
    what: z.string().describe("Type of place").default("restaurants"),
    where: z.string().describe("Location").default("San Francisco"),
  })
  .describe("Local search");
type Search = z.infer<typeof Search>;

const placePrompt = lift(({ name, description, what, where }) => {
  return {
    prompt: `a photo of ${name}, a ${what} in ${where} that matches the description: ${description}`,
  };
});

export const localSearch = recipe<typeof Search>(Search, ({ what, where }) => {
  const prompt = cell<string>("");

  const { result } = llm(buildPrompt({ prompt }));
  const places = grabJson({ result });

  return {
    [UI]: (
      <os-container>
        <common-hstack gap="sm">
          <common-vstack gap="xs">
            <div>What</div>
            <common-input
              value={what}
              placeholder="Type of place"
              oncommon-input={updateValue({ value: what })}
            />
          </common-vstack>
          <common-vstack gap="xs">
            <div>Where</div>
            <common-input
              value={where}
              placeholder="Location"
              oncommon-input={updateValue({ value: where })}
            />
          </common-vstack>
        </common-hstack>
        <common-button onclick={searchPlaces({ what, where, prompt })}>
          Search
        </common-button>
        <common-vstack gap="md">
          {places.map((place) => (
            <common-hstack>
              <img
                src={imageUrl(
                  placePrompt({
                    name: place.name,
                    description: place.description,
                    what,
                    where,
                  })
                )}
                width="300px"
              />
              <sl-card class="card-overview">
                <strong>{place.name}</strong>
                <div>{place.description}</div>
                <small>
                  {place.address}
                  <br />
                  {place.city}, {place.state} {place.zip}
                </small>
                <sl-rating
                  label="Rating"
                  readonly
                  value={place.rating}
                ></sl-rating>
              </sl-card>
            </common-hstack>
          ))}
        </common-vstack>
      </os-container>
    ),
    what,
    where,
    places,
    [NAME]: str`${what} in ${where}`,
  };
});
