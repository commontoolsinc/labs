import { html } from "@commontools/common-html";
import {
  recipe,
  lift,
  handler,
  ifElse,
  str,
  llm,
  navigateTo,
  UI,
  NAME,
} from "@commontools/common-builder";
import { addSuggestion, description } from "../suggestions.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

const LuftBnBPlace = z.object({
  id: z.string().describe("Unique identifier for the listing"),
  title: z.string().describe("Title of the listing"),
  location: z
    .string()
    .describe("Street corner, Neighborhood and city of the listing"),
  propertyType: z.enum(["Apartment", "House", "Room"]),
  pricePerNight: z.number().min(0),
  numberOfGuests: z.number().int().min(1),
  rating: z.number().min(0).max(5).describe("Average rating of the listing"),
  annotationUI: z.string().describe("empty string - do not add anything here"),
});

type LuftBnBPlace = z.infer<typeof LuftBnBPlace>;

const LuftBnBPlaces = z.array(LuftBnBPlace);

const jsonSchema = JSON.stringify(zodToJsonSchema(LuftBnBPlaces), null, 2);

const grabPlaces = lift<{ result?: string }, LuftBnBPlace[]>(({ result }) => {
  if (!result) {
    return [];
  }
  const jsonMatch = result.match(/```json\n([\s\S]+?)```/);
  if (!jsonMatch) {
    console.error("No JSON found in text:", result);
    return [];
  }
  let rawData = JSON.parse(jsonMatch[1]);
  let parsedData = z.array(LuftBnBPlace).safeParse(rawData);
  if (!parsedData.success) {
    console.error("Invalid JSON:", parsedData.error);
    return [];
  }
  return parsedData.data;
});

const copy = lift(({ value }: { value: string }) => value);

const asStars = lift((rating: number) => "⭐".repeat(Math.round(rating)));

const justMonthAndDay = lift((isoDate: string) =>
  isoDate.split("T")[0].slice(5)
);

const updateValue = handler<{ detail: { value: string } }, { value: string }>(
  ({ detail }, state) => detail?.value && (state.value = detail.value)
);

const handleSearchClick = handler<
  {},
  {
    startDate: string;
    endDate: string;
    location: string;
    startDateUI: string;
    endDateUI: string;
    locationUI: string;
  }
>((_, state) => {
  state.startDate = state.startDateUI;
  state.endDate = state.endDateUI;
  state.location = state.locationUI;
});

const makeBooking = handler<{}, { place: LuftBnBPlace }>((_, { place }) => {
  // TODO: This isn't serializable. Instead we have to add a way to trigger a
  // recipe from an event.
  return navigateTo(
    luftBnBBooking({
      place: {
        title: place.title,
        location: place.location,
        pricePerNight: place.pricePerNight,
      } as LuftBnBPlace,
      // TODO: This should come from the scope above, but we first have to build
      // currying of the recipe for this to work.
      startDate: "2024-09-06",
      endDate: "2024-09-08",
    })
  );
});

const buildQuery = lift(({ location, startDate, endDate }) => ({
  messages: [
    `generate 10 places for private home short-term rentals in ${location} between ${startDate} and ${endDate}`,
    "```json\n[",
  ],
  system: `Generate a list of places in json format\n\n<schema>${jsonSchema}</schema>`,
}));

export const luftBnBSearch = recipe<{
  startDate: string;
  endDate: string;
  location: string;
}>("luft bnb search", ({ startDate, endDate, location }) => {
  // TODO: This works because we recreate the recipe every time, but really this
  // should be dynamically generated at runtime.
  startDate.setDefault(
    new Date(new Date().getTime() + 86400).toISOString().split("T")[0]
  );
  endDate.setDefault(
    new Date(new Date().getTime() + 3 * 86400).toISOString().split("T")[0]
  );
  // TODO: This should be the user's default location, not hardcoded
  location.setDefault("San Francisco");

  const startDateUI = copy({ value: startDate });
  const endDateUI = copy({ value: endDate });
  const locationUI = copy({ value: location });

  const { result, pending } = llm(buildQuery({ location, startDate, endDate }));
  const places = grabPlaces({ result });

  return {
    [UI]: html`
      <common-vstack gap="sm">
        <common-hstack gap="sm">
          <common-input
            type="date"
            value=${startDateUI}
            placeholder="Start Date"
            oncommon-input=${updateValue({ value: startDateUI })}
          ></common-input>
          <common-input
            type="date"
            value=${endDateUI}
            placeholder="End Date"
            oncommon-input=${updateValue({ value: endDateUI })}
          ></common-input>
        </common-hstack>
        <common-input
          value=${locationUI}
          placeholder="Location"
          oncommon-input=${updateValue({ value: locationUI })}
        ></common-input>
        <common-button
          onclick=${handleSearchClick({
            startDate,
            endDate,
            location,
            startDateUI,
            endDateUI,
            locationUI,
          })}
          >Search</common-button
        >
        ${ifElse(
          pending,
          html`<div>Searching...</div>`,
          places.map(
            (place) => html`
              <common-vstack gap="xs">
                <div>${place.title}</div>
                <div>
                  ${place.propertyType}, ${place.numberOfGuests} max guests
                </div>
                <div>${place.location}</div>
                <div>
                  ${asStars(place.rating)}
                  (${place.rating})
                </div>
                <common-button onclick=${makeBooking({ place })}">
                  Book for $${place.pricePerNight} per night
                </common-button>
                ${place.annotationUI}
              </common-vstack>`
          )
        )}
        </common-vstack>
      </common-vstack>
    `,
    location,
    places,
    [NAME]: str`LuftBnB ${justMonthAndDay(startDate)} - ${justMonthAndDay(
      endDate
    )} in ${location}`,
  };
});

export const luftBnBBooking = recipe<{
  place: LuftBnBPlace;
  startDate: string;
  endDate: string;
}>("booking", ({ place, startDate, endDate }) => {
  return {
    [UI]: html`<div>
      Booked ${place.title} LuftBnB from ${startDate} to ${endDate} for
      $${place.pricePerNight} per night
    </div>`,
    [NAME]: str`Booking for LuftBnB in ${place.location}`,
    place,
    startDate,
    endDate,
  };
});

const computeBookingDatesFromEvent = lift(({ date }) => {
  const startDate = new Date(new Date(date).getTime() - 86400)
    .toISOString()
    .split("T")[0];
  const endDate = new Date(new Date(date).getTime() + 86400)
    .toISOString()
    .split("T")[0];
  return { startDate, endDate };
});

const describeFirstResult = lift(({ places, startDate, endDate }) => {
  return places && places.length
    ? `${places[0].propertyType} ${startDate}-${endDate} in ${
        places[0].location
      }. ${"⭐".repeat(Math.round(places[0].rating))} (${places[0].rating}). $${
        places[0].pricePerNight
      } per night`
    : "Searching...";
});

const makeLuftBnBSearch = recipe<{
  reservation: { date: string; location: string };
}>("book luftBnB for reservation", ({ reservation }) => {
  const { startDate, endDate } = computeBookingDatesFromEvent({
    date: reservation.date,
  });

  const luftBnB = luftBnBSearch({
    startDate,
    endDate,
    location: reservation.location,
  });

  return {
    [UI]: html`
      <vstack gap="sm">
        ${describeFirstResult({ places: luftBnB.places, startDate, endDate })}
        Or search for other places:
        <common-charm-link $charm=${luftBnB} />
      </vstack>
    `,
    reservation,
    luftBnBSearch: luftBnB,
  };
});

addSuggestion({
  description: description`Book LuftBnB for ${"reservation"}`,
  recipe: makeLuftBnBSearch,
  bindings: { task: "task" },
  charms: {
    reservation: "ticket",
  },
});

const NearbyPlace = z.object({
  id: z.string().describe("Unique identifier for the listing"),
  name: z.string().describe("Name of the place"),
  location: z.string().describe(`Street corner, Neighborhood and city`),
  walkingDistance: z.number().describe("Walking distance in minutes"),
});

type NearbyPlace = z.infer<typeof NearbyPlace>;

const generateNearbyPlaceQuery = lift(({ routine, places }) => {
  const locationType = routine.locations[0] ?? "coffee shop";

  const initialData = places.map((place: LuftBnBPlace) => ({
    location: place.location,
  }));

  const jsonSchema = JSON.stringify(zodToJsonSchema(NearbyPlace), null, 2);

  return {
    messages: [
      `generate ${initialData.length} ${locationType} with pun names`,
      "```json\n[",
    ],
    system: `Generate a list of ${locationType} places in json format\n\n<schema>${jsonSchema}</schema>`,
    stop: "```",
  };
});

// FIXME(ja): validate that the recommendations work here...
const grabNearbyPlaces = lift<{ result?: string }, NearbyPlace[]>(
  ({ result }) => {
    if (!result) {
      return [];
    }
    const jsonMatch = result.match(/```json\n([\s\S]+?)```/);
    if (!jsonMatch) {
      console.error("No JSON found in text:", result);
      return [];
    }

    let rawData = JSON.parse(jsonMatch[1]);
    let parsedData = z.array(NearbyPlace).safeParse(rawData);
    if (!parsedData.success) {
      console.error("Invalid JSON:", parsedData.error);
      return [];
    }
    return parsedData.data;
  }
);

// NOTE: This writes results into `places`
const annotatePlacesWithNearbyPlaces = lift(({ nearbyPlaces, places }) => {
  (nearbyPlaces ?? []).forEach(
    (place: { name: string; walkingDistance: number }, i: number) => {
      if (place)
        places[i].annotationUI = html`<div>
          ${place.name} is ${place.walkingDistance} min away
        </div>`;
    }
  );
});

const nearbyPlacesForRoutine = recipe<{
  routine: { locations: string[] };
  places: LuftBnBPlace[];
}>("annotate places for routine", ({ routine, places }) => {
  const nearbyPlaces = grabNearbyPlaces(
    llm(generateNearbyPlaceQuery({ routine, places }))
  );

  annotatePlacesWithNearbyPlaces({ nearbyPlaces, places });

  return { [UI]: html`<div></div>` };
});

addSuggestion({
  description: description`Find nearby places for ${"routine"}`,
  recipe: nearbyPlacesForRoutine,
  bindings: { places: "places" },
  charms: {
    routine: "routine",
  },
});
