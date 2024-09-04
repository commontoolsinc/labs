import { html } from "@commontools/common-html";
import {
  recipe,
  apply,
  lift,
  handler,
  generateData,
  UI,
  NAME,
} from "../builder/index.js";
import { run, getCellReferenceOrValue } from "../runner/index.js";
import { addSuggestion, description } from "../suggestions.js";
import { openSaga, addGems, ID } from "../data.js";

export interface LuftBnBPlace {
  // Schema for a place
  id: string;
  title: string;
  host: string;
  location: string;
  propertyType: "Apartment" | "House" | "Room";
  pricePerNight: number;
  numberOfGuests: number;
  latitude: number;
  longitude: number;
  rating: number;
  annotationUI: any;
}

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

  const startDateUI = lift(({ startDate }) => startDate)({ startDate });
  const endDateUI = lift(({ endDate }) => endDate)({ endDate });
  const locationUI = lift(({ location }) => location)({ location });

  const search = handler<
    {},
    {
      startDate: string;
      endDate: string;
      location: string;
      startDateUI: string;
      endDateUI: string;
      locationUI: string;
    }
  >(
    { startDate, endDate, location, startDateUI, endDateUI, locationUI },
    (_, state) => {
      state.startDate = state.startDateUI;
      state.endDate = state.endDateUI;
      state.location = state.locationUI;
    }
  );

  const query = lift(({ location }) => ({
    prompt: `generate 10 places for private home short-term rentals in ${location}`,
    result: [],
    schema: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Unique identifier for the listing",
          },
          title: {
            type: "string",
            description: "Title of the listing",
          },
          host: {
            type: "string",
            description: "Host of the listing",
          },
          location: {
            type: "string",
            description: "Street corner, Neighborhood and city of the listing",
          },
          propertyType: {
            type: "string",
            enum: ["Apartment", "House", "Room"],
          },
          pricePerNight: {
            type: "number",
            minimum: 0,
          },
          numberOfGuests: {
            type: "integer",
            minimum: 1,
          },
          latitude: {
            type: "number",
          },
          longitude: {
            type: "number",
          },
          rating: {
            type: "number",
            minimum: 0,
            maximum: 5,
            description: "Average rating of the listing",
          },
        },
        required: [
          "id",
          "title",
          "host",
          "location",
          "propertyType",
          "pricePerNight",
          "numberOfGuests",
          "imageUrl",
        ],
      },
    },
  }))({
    location,
  });

  const { result: places } = generateData<LuftBnBPlace[]>(query);

  return {
    [UI]: html`
      <common-vstack gap="sm">
        <common-hstack gap="sm">
          <common-input
            type="date"
            value=${startDateUI}
            placeholder="Start Date"
            oncommon-input=${handler(
              { startDateUI },
              ({ detail }, state) =>
                detail?.value && (state.startDateUI = detail.value)
            )}
          ></common-input>
          <common-input
            type="date"
            value=${endDateUI}
            placeholder="End Date"
            oncommon-input=${handler(
              { endDateUI },
              ({ detail }, state) =>
                detail?.value && (state.endDateUI = detail.value)
            )}
          ></common-input>
        </common-hstack>
        <common-input
          value=${locationUI}
          placeholder="Location"
          oncommon-input=${handler(
            { locationUI },
            ({ detail }, state) =>
              detail?.value && (state.locationUI = detail.value)
          )}
        ></common-input>
        <common-button onclick=${search}>Search</common-button>
        <common-vstack gap="md">
          ${places.map(
            (place) => html`
              <common-vstack gap="xs">
                <div>${place.title}</div>
                <div>
                  ${place.propertyType}, ${place.numberOfGuests} max guests
                </div>
                <div>${place.location}</div>
                <div>
                  ${lift((rating: number) => "⭐".repeat(Math.round(rating)))(
                    place.rating
                  )}
                  (${place.rating})
                </div>
                <common-button onclick=${handler({ place }, (_, { place }) => {
                  // TODO: This isn't serializable. Instead we have to add a way
                  // to trigger a recipe from an event.

                  const booking = run(luftBnBBooking, {
                    place: getCellReferenceOrValue(place),
                    // TODO: This should come from the scope above, but we
                    // first have to build currying of the recipe for this to
                    // work.
                    startDate: "2024-09-06",
                    endDate: "2024-09-08",
                  });

                  addGems([booking]);

                  openSaga(booking.get()[ID]);
                })}}">
                  Book for $${place.pricePerNight} per night
                </common-button>
                ${place.annotationUI}
              </common-vstack>
            `
          )}
        </common-vstack>
      </common-vstack>
    `,
    query,
    location,
    places,
    [NAME]: lift(
      ({ location, startDate, endDate }) =>
        `LuftBnB ${startDate?.slice(5)} - ${endDate?.slice(5)} in ${
          location ?? "anywhere"
        }`
    )({ location, startDate, endDate }),
  };
});

export const luftBnBBooking = recipe<{
  place: LuftBnBPlace;
  startDate: string;
  endDate: string;
}>("booking", ({ place, startDate, endDate }) => {
  const text = lift(
    ({ place, startDate, endDate }) =>
      `Booked ${place.title} LuftBnB from ${startDate} to ${endDate} for $${place.pricePerNight} per night`
  )({ place, startDate, endDate });
  const name = lift(({ place }) => `Booking for LuftBnB in ${place.location}`)({
    place,
  });
  return {
    [UI]: html`<div>${text}</div>`,
    [NAME]: name,
    place,
    startDate,
    endDate,
  };
});

const makeLuftBnBSearch = recipe<{
  reservation: { date: string; location: string };
}>("book luftBnB for reservation", ({ reservation }) => {
  const { startDate, endDate } = lift<{ date: string }>(({ date }) => {
    const startDate = new Date(new Date(date).getTime() - 86400)
      .toISOString()
      .split("T")[0];
    const endDate = new Date(new Date(date).getTime() + 86400)
      .toISOString()
      .split("T")[0];
    return { startDate, endDate };
  })({ date: reservation.date });

  const luftBnB = luftBnBSearch({
    startDate,
    endDate,
    location: reservation.location,
  });

  const topPlace = html`<div>
    ${apply(luftBnB, ({ places, startDate, endDate }) =>
      places && places.length
        ? `${places[0].propertyType} ${startDate}-${endDate} in ${
            places[0].location
          }. ${"⭐".repeat(Math.round(places[0].rating))} (${
            places[0].rating
          }). $${places[0].pricePerNight} per night`
        : "Searching..."
    )}
  </div>`;
  const searchId = lift((luftBnB: any) => luftBnB[ID])(luftBnB);

  return {
    [UI]: html`
      <vstack gap="sm">
        ${topPlace} Or search for other places:
        <common-saga-link saga=${searchId} />
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
  dataGems: {
    reservation: "ticket",
  },
});

const nearbyPlacesForRoutine = recipe<{
  routine: { locations: string[] };
  places: LuftBnBPlace[];
}>("annotate places for routine", ({ routine, places }) => {
  const query = lift(({ routine, places }) => {
    const locationType = routine.locations[0] ?? "coffee shop";

    const initialData = places.map((place: LuftBnBPlace) => ({
      location: place.location,
    }));

    return {
      prompt: `generate ${initialData.length} ${locationType} with pun names`,
      initialData,
      schema: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "Unique identifier for the listing",
            },
            name: {
              type: "string",
              description: `Name of the ${locationType}`,
            },
            location: {
              type: "string",
              description:
                "Street corner, Neighborhood and city of the ${locationType}",
            },
            walkingDistance: {
              type: "number",
              description: "Walking distance in minutes",
            },
          },
        },
      },
    };
  })({ routine, places });

  const { result } = generateData(query);

  lift(({ result, places }) => {
    (result ?? []).forEach(
      (place: { name: string; walkingDistance: number }, i: number) => {
        if (place)
          places[i].annotationUI = html`<div>
            ${place.name} is ${place.walkingDistance} min away
          </div>`;
      }
    );
  })({ result, places });

  return { [UI]: html`<div></div>` };
});

addSuggestion({
  description: description`Find nearby places for ${"routine"}`,
  recipe: nearbyPlacesForRoutine,
  bindings: { places: "places" },
  dataGems: {
    routine: "routine",
  },
});
