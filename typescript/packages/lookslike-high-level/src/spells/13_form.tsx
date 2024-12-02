import { h, behavior, $, select, Session } from "@commontools/common-system";
import { fromString } from "merkle-reference";


import { CommonInputEvent } from "../../../common-ui/lib/components/common-input.js";
import { defaultTo, event } from "../sugar.js";
import { Creature } from "./04_tamagotchi.jsx";
import * as Tamagotchi from "./04_tamagotchi.jsx";

const tamagotchiLab = behavior({
  render: Creature.render(
    ({ self, description, color, hunger, size, time }) => (
      <div>
        <common-input
          value={description}
          oncommon-input="~/on/change-description"
        />
        <common-input value={color} oncommon-input="~/on/change-color" />
        <common-input
          type="number"
          value={hunger}
          oncommon-input="~/on/change-hunger"
        />
        <common-input
          type="number"
          value={size}
          oncommon-input="~/on/change-size"
        />
        <common-input
          type="number"
          value={time}
          oncommon-input="~/on/change-time"
        />
        <p>
          {Tamagotchi.generateDescription({
            description,
            color,
            hunger,
            size,
            time,
          })}
        </p>
      </div>
    ),
  ).commit(),

  onChangeDescription: event("~/on/change-description")
    .with(Tamagotchi.description)
    .update(({ self, event }) => {
      const val = Session.resolve<CommonInputEvent>(event).detail.value;
      return [{ Upsert: [self, "description", val] }];
    })
    .commit(),

  onChangeColor: event("~/on/change-color")
    .with(Tamagotchi.color)
    .update(({ self, event }) => {
      const val = Session.resolve<CommonInputEvent>(event).detail.value;
      return [{ Upsert: [self, "color", val] }];
    })
    .commit(),

  onChangeHunger: event("~/on/change-hunger")
    .with(Tamagotchi.hunger)
    .update(({ self, event }) => {
      const val = Number(Session.resolve<CommonInputEvent>(event).detail.value);
      return [{ Upsert: [self, "hunger", val] }];
    })
    .commit(),

  onChangeSize: event("~/on/change-size")
    .with(Tamagotchi.size)
    .update(({ self, event }) => {
      const val = Number(Session.resolve<CommonInputEvent>(event).detail.value);
      return [{ Upsert: [self, "size", val] }];
    })
    .commit(),

  onChangeTime: event("~/on/change-time")
    .with(Tamagotchi.time)
    .update(({ self, event }) => {
      const val = Number(Session.resolve<CommonInputEvent>(event).detail.value);
      return [{ Upsert: [self, "time", val] }];
    })
    .commit(),
});

export default behavior({
  defaultUrl: select({ self: $.self })
    .not(q => q.match($.self, "~/target", $._))
    .assert(({ self }) => [self, "~/target", "bafy..."])
    .commit(),

  render: select({ self: $.self, targetId: $.targetId, target: $.target })
    .match($.self, "~/target", $.targetId)
    .clause(defaultTo($.self, "target", $.target, null))
    .render(({ self, targetId, target }) => (
      <div title="Tamagotchi Genetics Lab">
        <common-input value={targetId} oncommon-input="~/on/change-target" />
        <button onclick="~/on/reset">Reset</button>
        <pre>{JSON.stringify(target, null, 2)}</pre>
        {target ? (
          <fieldset>
            <common-charm
              key={target.toString()}
              id={target.toString()}
              entity={() => target}
              spell={() => tamagotchiLab}
            />
          </fieldset>
        ) : (
          <div></div>
        )}
      </div>
    ))
    .commit(),

  onChangeTarget: select({ self: $.self, event: $.event })
    .match($.self, "~/on/change-target", $.event)
    .update(({ self, event }) => {
      const val = Session.resolve<CommonInputEvent>(event).detail.value;
      const entity = fromString(val);

      // common-input gives us events with easy to read values
      return [
        { Upsert: [self, "~/target", val] },
        { Upsert: [self, "target", entity] },
      ];
    })
    .commit(),

  onReset: select({ self: $.self, target: $.target })
    .match($.self, "~/on/reset")
    .clause(defaultTo($.self, "target", $.target, null))
    .update(({ self, target }) => {
      return [{ Retract: [self, "target", target] }];
    })
    .commit(),
});
