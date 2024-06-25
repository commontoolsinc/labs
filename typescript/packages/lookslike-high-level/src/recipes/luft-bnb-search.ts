import { view, tags } from "@commontools/common-ui";
import { signal, stream } from "@commontools/common-frp";
import { generateData } from "@commontools/llm-client";
import { recipe, NAME } from "../recipe.js";
import { mockResultClient } from "../llm-client.js";
const { binding, repeat } = view;
const { vstack, hstack, div, commonInput, button, input } = tags;
const { state, computed } = signal;
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
        name: place.title,
        description:
          place.propertyType + `, ${place.numberOfGuests} max guests`,
        location: place.location,
        rating: "⭐⭐⭐⭐⭐".slice(0, place.rating) + ` (${place.rating})`,
        bookFor: `Book for $${place.pricePerNight} per night`,
      }))
    );

    const book = subject<{ id: string }>();
    book.sink({
      send: ({ id }) =>
        console.log(`Booked ${places.get().find((place) => place.id === id)}`),
    });

    return {
      UI: vstack({}, [
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
              button({ "@click": book, id: binding("id") }, binding("bookFor")),
            ])
          )
        ),
      ]),
      startDate,
      endDate,
      location,
      places,
      [NAME]: computed(
        [location],
        (location: string) => `LuftBnB in ${location || "anywhere"}`
      ),
    };
  }
);

async function performLuftBnBSearch(location: string): Promise<LuftBnBPlace[]> {
  if (!location) return [];
  const result = await generateData(
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
  );
  return result as LuftBnBPlace[];
}
