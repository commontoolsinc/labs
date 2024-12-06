import { h, behavior, $, select, Session } from "@commontools/common-system";
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

export const foo = field("foo", 0);
// export const size = field("size", 1);
// export const time = field("time", 0);
// export const description = field("description", "lizard bunny");
// export const color = field("color", "blue");
// export const lastActivity = field("lastActivity", "");
// const resolveUninitialized = select({ self: $.self })
//   .clause(isEmpty($.self, "hunger"))
//   .clause(isEmpty($.self, "size"))
//   .clause(isEmpty($.self, "time"));

// export const resolveCreature = description
//   .with(hunger)
//   .with(size)
//   .with(time)
//   .with(color)
//   .with(lastActivity);

export const myFoodPal = behavior({
  render: foo
    .render(({ self, foo }) => (
      <div entity={self}>
        <span>{foo}</span>
      </div>
    ))
    .commit(),

  // onChangeDescription: event("~/on/change-description")
  //   .with(Tamagotchi.description)
  //   .update(({ self, event }) => {
  //     const val = Session.resolve<CommonInputEvent>(event).detail.value;
  //     return [{ Upsert: [self, "description", val] }];
  //   })
  //   .commit(),
});

export const spawn = (source: {} = { myFoodPal: 1 }) =>
  myFoodPal.spawn(source, "MyFoodPal");
