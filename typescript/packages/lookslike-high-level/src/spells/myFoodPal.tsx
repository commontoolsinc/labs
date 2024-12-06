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
      fat: 0.4,
    },
  },
];

const entry = {
  id: "meal_123",
  timestamp: "2024-12-06T07:30:00Z",
  mealType: "breakfast",
  foods: [
    {
      foodId: "food_125",
      qty: 1, // one serving of Greek Yogurt
    },
    {
      foodId: "food_127",
      qty: 1, // one banana
    },
  ],
  notes: "Quick breakfast before work",
};

// export const foo = field("foo", 0);

export const myFoodPal = behavior({
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
      },
    ],
  })
    .match($.self, "foods", $.foodId)
    .match($.foodId, "name", $.name)
    .render(EmptyState)
    .commit(),
});

function EmptyState({
  self,
  foods,
}: {
  self: Reference;
  foods: { id: Reference; name: string }[];
}) {
  return (
    <div title={"My Food Pal"} entity={self}>
      <h1>foods!</h1>
      <pre>{JSON.stringify(foods, null, 2)}</pre>
    </div>
  );
}

export const spawn = (source: {} = { myFoodPal: 2 }) =>
  myFoodPal.spawn(source, "MyFoodPal");
