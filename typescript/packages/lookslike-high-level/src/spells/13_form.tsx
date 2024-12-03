import { h, behavior, $, select, Session } from "@commontools/common-system";
import { fromString } from "merkle-reference";


import { CommonInputEvent } from "../../../common-ui/lib/components/common-input.js";
import { defaultTo, event } from "../sugar.js";
import { Creature } from "./04_tamagotchi.jsx";
import * as Tamagotchi from "./04_tamagotchi.jsx";
const formContainerStyle = `
  padding: 20px;
  background: #f0f0f0;
  border: 2px solid #ccc;
  border-radius: 8px;
  font-family: monospace;
  max-width: 320px;
  margin: 0 auto;
`;

const inputGroupStyle = `
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 10px;
  margin-bottom: 20px;
`;

const inputLabelStyle = `
  font-size: 12px;
  color: #666;
  font-weight: bold;
  text-transform: uppercase;
`;

const displayPanelStyle = `
  border: 3px solid #666;
  border-radius: 15px;
  padding: 20px;
  background: #222;
  box-shadow: inset 0 0 20px rgba(0,0,0,0.5);
`;

const imageStyle = `
  width: 100%;
  border-radius: 12px;
  border: 2px solid #444;
`;

const tamagotchiLab = behavior({
  render: Creature.render(
    ({ self, description, color, hunger, size, time }) => (
      <div style={formContainerStyle}>
        <div style={inputGroupStyle}>
          <div>
            <div style={inputLabelStyle}>Description</div>
            <common-input
              value={description}
              oncommon-blur="~/on/change-description"
            />
          </div>
          <div>
            <div style={inputLabelStyle}>Color</div>
            <common-input value={color} oncommon-blur="~/on/change-color" />
          </div>
          <div>
            <div style={inputLabelStyle}>Hunger</div>
            <common-input
              type="number"
              value={hunger}
              oncommon-blur="~/on/change-hunger"
            />
          </div>
          <div>
            <div style={inputLabelStyle}>Size</div>
            <common-input
              type="number"
              value={size}
              oncommon-blur="~/on/change-size"
            />
          </div>
          <div>
            <div style={inputLabelStyle}>Time</div>
            <common-input
              type="number"
              value={time}
              oncommon-blur="~/on/change-time"
            />
          </div>
        </div>
        <div style={displayPanelStyle}>
          <img
            style={imageStyle}
            src={Tamagotchi.genImage(
              `A creature in a science lab happily being experimented on. ${Tamagotchi.generateDescription({ time, size, color, description, hunger })}`
            )}
          />
        </div>
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
        {target ? (
          <div>
            <common-charm
              key={target.toString()}
              id={target.toString()}
              entity={() => target}
              spell={() => tamagotchiLab}
            />
          </div>
        ) : (
          <div></div>
        )}

        <details>
          <summary>Debug</summary>
          <pre>{JSON.stringify(target, null, 2)}</pre>
        </details>
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
