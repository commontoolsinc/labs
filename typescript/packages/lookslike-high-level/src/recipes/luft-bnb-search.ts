import { html } from "@commontools/common-html";
import {
  recipe,
  lift,
  handler,
  str,
  generateData,
  UI,
  NAME,
} from "@commontools/common-builder";
import { addSuggestion, description } from "../suggestions.js";
import { launch, ID } from "../data.js";

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

const makeBooking = handler<
  {},
  {
    place: LuftBnBPlace;
  }
>((_, { place }) => {
  // TODO: This isn't serializable. Instead we have to add a way to trigger a
  // recipe from an event.
  launch(luftBnBBooking, {
    place: {
      title: place.title,
      location: place.location,
      pricePerNight: place.pricePerNight,
    },
    // TODO: This should come from the scope above, but we first have to build
    // currying of the recipe for this to work.
    startDate: "2024-09-06",
    endDate: "2024-09-08",
  });
});

const buildQuery = lift(({ location }) => ({
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

  const { result: places } = generateData<LuftBnBPlace[]>(
    buildQuery({ location })
  );

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
                  ${asStars(place.rating)}
                  (${place.rating})
                </div>
                <common-button onclick=${makeBooking({ place })}">
                  Book for $${place.pricePerNight} per night
                </common-button>
                ${place.annotationUI}
              </common-vstack>
            `
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
        <common-charm-link charm=${luftBnB[ID]} />
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

const generateNearbyPlaceQuery = lift(({ routine, places }) => {
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
});

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
  const query = generateNearbyPlaceQuery({ routine, places });

  const { result: nearbyPlaces } = generateData(query);

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
