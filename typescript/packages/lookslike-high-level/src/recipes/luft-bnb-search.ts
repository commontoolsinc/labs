import { html } from "@commontools/common-html";
import {
  recipe,
  apply,
  lift,
  handler,
  cell,
  generateData,
  UI,
  NAME,
} from "../builder/index.js";
import { addSuggestion, description } from "../suggestions.js";

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
    new Date(new Date().getTime() + 2 * 86400).toISOString().split("T")[0]
  );
  // TODO: This should be the user's default location, not hardcoded
  location.setDefault("San Francisco");

  const query = cell({
    prompt: "",
  });

  const search = handler<
    {},
    {
      startDate: string;
      endDate: string;
      location: string;
      query: { prompt: string };
    }
  >({ startDate, endDate, location, query }, (_, { location, query }) => {
    query.prompt = `generate 10 places for private home short-term rentals in ${location}`;
  });

  const { result: places } = generateData<LuftBnBPlace[]>({
    prompt: query.prompt,
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
  });

  const book = handler<{ id: string }, { places: LuftBnBPlace[] }>(
    { places },
    ({ id }, { places }) => {
      const place = places.find((p) => p.id === id);
      if (place) {
        console.log("Booked", place);
        // Implement booking logic here
      }
    }
  );

  return {
    [UI]: html`
      <common-vstack gap="sm">
        <common-hstack gap="sm">
          <common-input
            type="date"
            value=${startDate}
            placeholder="Start Date"
            @common-input#value=${startDate}
          ></common-input>
          <common-input
            type="date"
            value=${endDate}
            placeholder="End Date"
            @common-input#value=${endDate}
          ></common-input>
        </common-hstack>
        <common-input
          value=${location}
          placeholder="Location"
          @common-input#value=${location}
        ></common-input>
        <common-button @click=${search}>Search</common-button>
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
                <common-button @click=${book} id="${place.id}}">
                  Book for $${place.pricePerNight} per night
                </common-button>
              </common-vstack>
            `
          )}
        </common-vstack>
      </common-vstack>
    `,
    query,
    location,
    places,
    [NAME]: apply(
      { location, startDate, endDate },
      (location, startDate, endDate) =>
        `LuftBnB ${startDate?.slice(5)} - ${endDate?.slice(5)} in ${
          location || "anywhere"
        }`
    ),
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
    UI: html`<div>${text}</div>`,
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

  return {
    UI: html`
      <vstack gap="sm">
        ${luftBnB.summaryUI} Or search for other places:
        <sagaLink saga=${luftBnB}></sagaLink>
      </vstack>
    `,
    reservation,
    luftBnBSearch: luftBnB,
  };
});

addSuggestion({
  description: description`Book LuftBnB for ${"reservation"}`,
  recipe: makeLuftBnBSearch,
  bindings: { done: "done" },
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

  const { partial } = generateData(query);

  lift(({ partial, places }) => {
    partial.forEach(
      (place: { name: string; walkingDistance: number }, i: number) => {
        places[i].annotationUI = html`<div>
          ${place.name} is ${place.walkingDistance} min away
        </div>`;
      }
    );
  })({ partial, places });

  return { UI: html`<div></div>` };
});

addSuggestion({
  description: description`Find nearby places for ${"routine"}`,
  recipe: nearbyPlacesForRoutine,
  bindings: { places: "places" },
  dataGems: {
    routine: "routine",
  },
});
