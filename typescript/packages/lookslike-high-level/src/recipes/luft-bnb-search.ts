import { view, tags } from "@commontools/common-ui";
import { signal, stream, Sendable } from "@commontools/common-frp";
import { generateData } from "@commontools/llm-client";
import { Gem, recipe, NAME, addSuggestion, description } from "../recipe.js";
import { sagaLink } from "../components/saga-link.js";
import { addGems } from "../data.js";
import { mockResultClient } from "../llm-client.js";
const { binding, repeat } = view;
const { vstack, hstack, div, commonInput, button, input, include } = tags;
const { state, computed, effect } = signal;
const { subject } = stream;

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
  annotationUI: Sendable<view.VNode>;
}

export const luftBnBSearch = recipe(
  "local search",
  ({ startDate, endDate, location }) => {
    // Initial search
    const places = state<LuftBnBPlace[]>([]);
    performLuftBnBSearch(location.get()).then((results) =>
      places.send(results)
    );

    const search = subject<any>();
    search.sink({
      send: () =>
        performLuftBnBSearch(location.get()).then((results) =>
          places.send(results)
        ),
    });

    const summaries = computed([places], (places: LuftBnBPlace[]) =>
      places.map((place) => ({
        id: place.id,
        name: place.title,
        description:
          place.propertyType + `, ${place.numberOfGuests} max guests`,
        location: place.location,
        rating: `${"⭐⭐⭐⭐⭐".slice(0, place.rating)} (${place.rating})`,
        bookFor: `Book for $${place.pricePerNight} per night`,
        annotationUI: place.annotationUI,
      }))
    );

    const book = subject<{ id: string }>();
    const booking = state<Gem | undefined>(undefined);
    book.sink({
      send: ({ id }) => {
        const place = places.get().find((place) => place.id === id);
        const newBooking = luftBnBBooking({ place, startDate, endDate });
        addGems([newBooking]);
        booking.send(newBooking);
        console.log("Booked", place);
      },
    });

    const summaryUI = computed(
      [booking, places, startDate, endDate],
      (booking, places: LuftBnBPlace[], startDate, endDate) => {
        if (booking) return booking.UI;
        if (!places.length) return div({}, ["Searching..."]);
        const place = places[0];
        return vstack({}, [
          `${place.propertyType}, ${startDate}-${endDate} in ${place.location}. ` +
            `${"⭐⭐⭐⭐⭐".slice(0, place.rating)} (${place.rating})`,
          button({ "@click": book, id: place.id }, [
            `Book for $${place.pricePerNight} per night`,
          ]),
        ]);
      }
    );

    return {
      UI: computed([booking], (booking) =>
        booking
          ? include({ content: booking.UI })
          : vstack({}, [
              hstack({}, [
                input({
                  type: "date",
                  value: startDate,
                  placeholder: "Type of place",
                  "@common-input#value": startDate,
                }),
                input({
                  type: "date",
                  value: endDate,
                  placeholder: "Type of place",
                  "@common-input#value": endDate,
                }),
              ]),
              commonInput({
                value: location,
                placeholder: "Location",
                "@common-input#value": location,
              }),
              button({ "@click": search }, ["Search"]),
              vstack(
                {},
                repeat(
                  summaries,
                  vstack({}, [
                    div({}, binding("name")),
                    div({}, binding("description")),
                    div({}, binding("location")),
                    div({}, binding("rating")),
                    include({ content: binding("annotationUI") }),
                    button(
                      { "@click": book, id: binding("id") },
                      binding("bookFor")
                    ),
                  ])
                )
              ),
            ])
      ),
      summaryUI: summaryUI,
      startDate,
      endDate,
      location,
      places,
      booking,
      [NAME]: computed(
        [location, startDate, endDate],
        (location, startDate: string, endDate: string) =>
          `LuftBnB ${startDate.slice(5)} - ${endDate.slice(5)} in ${location || "anywhere"}`
      ),
    };
  }
);

export const luftBnBBooking = recipe(
  "booking",
  ({ place, startDate, endDate }) => {
    const text = computed(
      [place, startDate, endDate],
      (place: LuftBnBPlace, startDate, endDate) =>
        `Booked ${place.title} LuftBnB from ${startDate} to ${endDate} for $${place.pricePerNight} per night`
    );
    const name = computed(
      [place],
      (place: LuftBnBPlace) => `Booking for LuftBnB in ${place.location}`
    );
    return { UI: div({}, text), [NAME]: name, place, startDate, endDate };
  }
);

async function performLuftBnBSearch(location: string): Promise<LuftBnBPlace[]> {
  if (!location) return [];
  const result = (await generateData(
    mockResultClient,
    `generate 10 places for private home short-term rentals in ${location}`,
    [],
    {
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
    }
  )) as LuftBnBPlace[];
  return result.map((result) => ({
    ...result,
    annotationUI: state<view.VNode>(div({}, [""])),
  }));
}

const makeLuftBnBSearch = recipe(
  "book luftBnB for reservation",
  ({ reservation }) => {
    const luftBnB: signal.Signal<Gem> = computed(
      [reservation],
      ({ date, location }) => {
        const startDate = computed(
          [date],
          (date: string) =>
            new Date(new Date(date).getTime() - 86400)
              .toISOString()
              .split("T")[0]
        );
        const endDate = computed(
          [date],
          (date: string) =>
            new Date(new Date(date).getTime() + 86400)
              .toISOString()
              .split("T")[0]
        );

        return luftBnBSearch({
          startDate,
          endDate,
          location,
        });
      }
    );

    return {
      UI: vstack({}, [
        include({
          // TODO: This should be a computed, but we can't yet flatten computed values
          content: luftBnB.get().summaryUI,
        }),
        "Or search for other places:",
        sagaLink({ saga: luftBnB }),
      ]),
      reservation,
      luftBnBSearch: luftBnB,
    };
  }
);

addSuggestion({
  description: description`Book LuftBnB for ${"reservation"}`,
  recipe: makeLuftBnBSearch,
  bindings: { done: "done" },
  dataGems: {
    reservation: "ticket",
  },
});

const nearbyPlacesForRoutine = recipe(
  "annotate places for routine",
  ({ routine, places }) => {
    effect(
      [places, routine],
      (
        places: LuftBnBPlace[],
        routine: { locations: signal.Signal<string[]> }
      ) => {
        // 1. Extract the requested locations from the routine
        // TODO: Should be a path above, or a nested effect..
        const locationType = routine.locations.get()[0];

        // 2. Extact places to annotate
        const initialData = places.map((place) => ({
          location: place.location,
        }));

        // 3. Query LLM to annotate these places with requested locations
        const resultPromise = generateData(
          mockResultClient,
          `generate ${initialData.length} ${locationType} with pun names`,
          initialData,
          {
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
          }
        );

        // 4. Annotate the places by setting the annotationUI state
        resultPromise.then((result) => {
          console.log("Annotated places", result);
          const annotatedPlaces = result as {
            name: string;
            walkingDistance: number;
          }[];
          places.forEach((place, i) => {
            place.annotationUI.send(
              div({}, [
                `${annotatedPlaces[i].name} is ${annotatedPlaces[i].walkingDistance} min away`,
              ])
            );
          });
        });
      }
    );

    return { UI: div({}) };
  }
);

addSuggestion({
  description: description`Find nearby places for ${"routine"}`,
  recipe: nearbyPlacesForRoutine,
  bindings: { places: "places" },
  dataGems: {
    routine: "routine",
  },
});
