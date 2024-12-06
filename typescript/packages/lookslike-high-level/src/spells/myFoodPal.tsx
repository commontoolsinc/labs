import {
  Instruction,
  h,
  behavior,
  $,
  select,
  Session,
  Reference,
} from "@commontools/common-system";
import { fromString } from "merkle-reference";
import { CommonInputEvent } from "../../../common-ui/lib/components/common-input.js";
import {
  addTag,
  defaultTo,
  event,
  events,
  field,
  isEmpty,
  set,
  subview,
  Transact,
} from "../sugar.js";

import { refer } from "synopsys";

const foodItems = [
  {
    name: "Chicken Breast",
    servingSize: 100,
    servingUnit: "g",
    nutrients: {
      calories: 165,
      protein: 31,
      carbohydrates: 0,
      fat: 3.6,
    },
  },
  {
    name: "Apple",
    servingSize: 1,
    servingUnit: "medium apple",
    nutrients: {
      calories: 95,
      protein: 0.5,
      carbohydrates: 25,
      fat: 0.3,
    },
  },
  {
    name: "Greek Yogurt",
    servingSize: 170,
    servingUnit: "g",
    nutrients: {
      calories: 100,
      protein: 17,
      carbohydrates: 6,
      fat: 0.4,
    },
  },
  {
    name: "Slice of Whole Wheat Bread",
    servingSize: 1,
    servingUnit: "slice",
    nutrients: {
      calories: 110,
      protein: 4,
      carbohydrates: 20,
      fat: 1.5,
    },
  },
  {
    name: "Banana",
    servingSize: 1,
    servingUnit: "medium banana",
    nutrients: {
      calories: 105,
      protein: 1.3,
      carbohydrates: 27,
      // fat: 0.4,
    },
  },
];

export const myFoodPalFoodGrid = behavior({
  importFoods: select({ self: $.self })
    .not(q => q.match($.self, "foods", $._))
    .update(({ self }) =>
      foodItems.flatMap(food => {
        const id = refer(food);
        return [
          { Import: food },
          { Assert: [self, "foods", id] } as Instruction,
        ];
      }),
    )
    .commit(),

  render: select({
    self: $.self,
    foods: [
      {
        id: $.foodId,
        name: $.name,
        servingSize: $.servingSize,
        servingUnit: $.servingUnit,
        nutrients: {
          calories: $.calories,
          protein: $.protein,
          carbohydrates: $.carbohydrates,
          fat: $.fat,
        },
      },
    ],
  })
    .match($.self, "foods", $.foodId)
    .match($.foodId, "name", $.name)
    .match($.foodId, "nutrients", $.nutrient)
    .match($.nutrient, "calories", $.calories)
    .match($.nutrient, "protein", $.protein)
    .match($.nutrient, "carbohydrates", $.carbohydrates) // This is an example of how to handle optional fields. Maybe the default should be falsy like null?
    .clause(defaultTo($.nutrient, "fat", $.fat, 0))
    .match($.foodId, "servingSize", $.servingSize)
    .match($.foodId, "servingUnit", $.servingUnit)
    .render(MyFoodPalFoodGrid)
    .commit(),
});

function MyFoodPalFoodGrid({
  self,
  foods,
}: {
  self: Reference;
  foods: {
    id: Reference;
    name: string;
    nutrients: any;
    servingSize: number;
    servingUnit: string;
  }[];
}) {
  return (
    <div title={"My Food Pal"} entity={self}>
      <h1>foods!</h1>
      <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px;">
        {foods.map(({ id, name, nutrients, servingSize, servingUnit }) => (
          <div
            key={id}
            style="border: 2px solid #ccc; border-radius: 8px; padding: 20px;"
          >
            <h2>{name}</h2>
            <img
              width={250}
              height={250}
              style="object-fit: cover; border-radius: 8px;"
              src={`/api/img?prompt=${encodeURIComponent("cute hello kitty themed food illustration of a " + name)}`}
            />
            <h3>Nutrition</h3>
            <span>
              Serving Size: {servingSize} {servingUnit}
            </span>
            <table>
              <tbody>
                <tr>
                  <td>Calories</td>
                  <td>{nutrients.calories}</td>
                </tr>
                <tr>
                  <td>Protein</td>
                  <td>{nutrients.protein}</td>
                </tr>
                <tr>
                  <td>Carbohydrates</td>
                  <td>{nutrients.carbohydrates}</td>
                </tr>
                {nutrients.fat === 0 ? (
                  ""
                ) : (
                  <tr>
                    <td>Fat</td>
                    <td>{nutrients.fat}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  );
}

const entry = {
  timestamp: "2024-12-06T07:30:00Z",
  mealType: "breakfast",
  notes: "Quick breakfast before work",

  foods: ["ref1", "ref2"],
};

// const entryDraftRef = refer({ name: "entryDraft" });
// const DraftTitle = select({ self: $.self, draftTitle: $.draftTitle }).clause(
//   defaultTo($.self, "draft/title", $.draftTitle, ""),
// );
// export const mealType = select({ self: entryDraftRef, notes: $.notes }).clause(
// defaultTo($.self, "notes", $.notes, ""),
// );
// NOTE(jake): Can these use local ~/mealType and ~/notes?
export const mealType = field("mealType", "breakfast");
export const notes = field("notes", "");
export const mealFoods = field("mealFoods", []);

export const myFoodPalEntryView = behavior({
  importFoods: select({ self: $.self })
    .not(q => q.match($.self, "foods", $._))
    .update(({ self }) =>
      foodItems.flatMap(food => {
        const id = refer(food);
        return [
          { Import: food },
          { Assert: [self, "foods", id] } as Instruction,
        ];
      }),
    )
    .commit(),

  render: select({
    self: $.self,
    mealType: $.mealType,
    notes: $.notes,

    foods: [
      {
        id: $.foodId,
        name: $.name,
      },
    ],
  })
    .match($.self, "foods", $.foodId)
    .match($.foodId, "name", $.name)
    .with(mealType)
    .with(notes)
    .render(MyFoodPalEntryView)
    .commit(),

  onChangeMealType: event("~/on/change-meal-type")
    .update(({ self, event }) => {
      const val = Session.resolve<CommonInputEvent>(event).detail.value;
      return [{ Upsert: [self, "mealType", val] }];
    })
    .commit(),

  onChangeNotes: event("~/on/change-notes")
    .update(({ self, event }) => {
      const val = Session.resolve<CommonInputEvent>(event).detail.value;
      return [{ Upsert: [self, "notes", val] }];
    })
    .commit(),

  onAddEntry: event("~/on/add-entry")
    .update(({ self, event }) => {
      const ref = Session.resolve<CommonInputEvent>(event).detail.value;
      return [{ Assert: [self, "entryDraft", ref] }];
    })
    .commit(),
});

function MyFoodPalEntryView({
  self,
  foods,
  notes,
  mealType,
}: {
  self: Reference;
  notes: string;
  mealType: string;
  foods: {
    id: Reference;
    name: string;
  }[];
}) {
  return (
    <div title={"My Food Pal"} entity={self}>
      <h1>Add meal entry</h1>

      <div>
        <div>
          <label>Meal Type</label>
          <common-input
            value={mealType}
            oncommon-blur="~/on/change-meal-type"
          />
        </div>
        <div>
          <label>Notes</label>
          <common-input value={notes} oncommon-blur="~/on/change-notes" />
        </div>

        <common-button onclick="~/on/add-entry">Add Entry</common-button>
      </div>

      <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px;">
        {foods.map(({ id, name }) => (
          <div
            key={id}
            style="border: 2px solid #ccc; border-radius: 8px; padding: 20px;"
          >
            <h2>{name}</h2>
            <img
              width={250}
              height={250}
              style="object-fit: cover; border-radius: 8px;"
              src={`/api/img?prompt=${encodeURIComponent("cute hello kitty themed food illustration of a " + name)}`}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

export const spawn = (source: {} = { myFoodPal: 5 }) =>
  myFoodPalEntryView.spawn(source, "MyFoodPal");
