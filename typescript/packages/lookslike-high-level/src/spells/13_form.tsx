import { h, behavior, $, select, Session } from "@commontools/common-system";
import { fromString } from "merkle-reference";
import { CommonInputEvent } from "../../../common-ui/lib/components/common-input.js";
import { defaultTo, event, isEmpty, Transact } from "../sugar.js";
import { resolveCreature } from "./04_tamagotchi.jsx";
import * as Tamagotchi from "./04_tamagotchi.jsx";
const styles = {
  formContainer: `
    padding: 20px;
    background: #f0f0f0;
    border: 2px solid #ccc;
    border-radius: 8px;
    font-family: monospace;
    max-width: 320px;
    margin: 0 auto;
  `,

  inputGroup: `
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 10px;
    margin-bottom: 20px;
  `,

  inputLabel: `
    font-size: 12px;
    color: #666;
    font-weight: bold;
    text-transform: uppercase;
  `,

  displayPanel: `
    border: 3px solid #666;
    border-radius: 15px;
    padding: 20px;
    background: #222;
    box-shadow: inset 0 0 20px rgba(0,0,0,0.5);
  `,

  image: `
    width: 100%;
    border-radius: 12px;
    border: 2px solid #444;
  `
};

const tamagotchiLab = behavior({
  render: resolveCreature.render(
    ({ self, description, color, hunger, size, time }) => (
      <div entity={self} style={styles.formContainer}>
        <div style={styles.inputGroup}>
          <div>
            <div style={styles.inputLabel}>Description</div>
            <common-input
              value={description}
              oncommon-blur="~/on/change-description"
            />
          </div>
          <div>
            <div style={styles.inputLabel}>Color</div>
            <common-input value={color} oncommon-blur="~/on/change-color" />
          </div>
          <div>
            <div style={styles.inputLabel}>Hunger</div>
            <common-input
              type="number"
              value={hunger}
              oncommon-blur="~/on/change-hunger"
            />
          </div>
          <div>
            <div style={styles.inputLabel}>Size</div>
            <common-input
              type="number"
              value={size}
              oncommon-blur="~/on/change-size"
            />
          </div>
          <div>
            <div style={styles.inputLabel}>Time</div>
            <common-input
              type="number"
              value={time}
              oncommon-blur="~/on/change-time"
            />
          </div>
        </div>
        <div style={styles.displayPanel}>
          <img
            style={styles.image}
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

const resolveTarget = select({ self: $.self, target: $.target })
  .clause(defaultTo($.self, "target", $.target, null))
const resolveTargetIdInput = select({ self: $.self, targetId: $.targetId })
  .match($.self, "~/target", $.targetId)

export default behavior({
  defaultUrl: select({ self: $.self })
    .clause(isEmpty($.self, "~/target"))
    .update(({ self }) =>
      Transact.assert(self, { '~/target': 'bafy...' })
    )
    .commit(),

  view: resolveTargetIdInput
    .with(resolveTarget)
    .render(({ self, targetId, target }) => (
      <div entity={self} title="Tamagotchi Genetics Lab">
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

  onChangeTarget:
    event("~/on/change-target")
      .update(({ self, event }) => {
        const val = Session.resolve<CommonInputEvent>(event).detail.value;
        const entity = fromString(val);

        return Transact.set(self, {
          "~/target": val,
          target: entity
        });
      })
      .commit(),

  onReset: event("~/on/reset")
    .with(resolveTarget)
    .update(({ self, target }) => {
      return [{ Retract: [self, "target", target] }];
    })
    .commit(),
});
