import { h } from "@commontools/common-html";
import {
  Spell,
  type OpaqueRef,
  handler,
  select,
  $,
  derive,
} from "@commontools/common-builder";

type Counter = {
  title: string;
  count: number;
};

type Counters = {
  title: string;
  counters: Counter[];
  total: number;
};

const handleCounterIncrement = handler<{}, { counter: Counter }>(function (
  {},
  { counter },
) {
  counter.count += 1;
});

const handleUpdateSpellTitle = handler<
  { detail: { value: string } },
  { title: string }
>(function ({ detail: { value } }, state) {
  state.title = value;
});

const handleUpdateCounterTitle = handler<
  { detail: { value: string } },
  { counter: Counter }
>(function ({ detail: { value } }, { counter }) {
  counter.title = value;
});

const handleRemoveCounter = handler<
  {},
  { counter: Counter; counters: Counter[] }
>(function ({}, { counter, counters }) {
  // FIXME(ja): not having equality check on objects is a problem, ideally we
  // could have `counters.indexOf(counter)`.
  const index = counters.findIndex(
    (i: Counter) => i.title === counter.title && i.count === counter.count,
  );
  if (index !== -1) {
    counters.splice(index, 1);
  }
});

const handleAddCounter = handler<{}, { counters: Counter[] }>(function (
  {},
  state,
) {
  state.counters.push({
    title: "untitled counter " + state.counters.length,
    count: 0,
  });
});

export class CountersSpell extends Spell<Counters> {
  constructor() {
    super();

    this.addRule(select({ counters: $.counters }), ({ self, counters }) => {
      self.total = counters.reduce(
        (acc: number, counter: Counter) => acc + counter.count,
        0,
      );
    });
  }

  override init() {
    return {
      title: "untitled counters",
      counters: [],
      $NAME: "counters name",
      total: 0,
    };
  }

  override render({ title, counters, total }: OpaqueRef<Counters>) {
    return (
      <div style="padding: 10px;">
        <common-vstack gap="md">
          <div style="background: #f0f0f0; padding: 10px; border-radius: 5px;">
            <label>Update Title</label>
            <common-input
              value={title}
              oncommon-input={handleUpdateSpellTitle.with({ title })}
            />
          </div>
          <h1>{title}</h1>
        </common-vstack>
        <common-vstack gap="md">
          {counters.map(counter => (
            <div style="background: #f0f0f0; padding: 10px; border-radius: 5px;">
              <common-vstack gap="md">
                <common-input
                  style="width: 200px"
                  value={counter.title}
                  oncommon-input={handleUpdateCounterTitle.with({ counter })}
                />

                <common-hstack gap="md">
                  <h3>{counter.count}</h3>
                  <div class="actions" style="display: flex; gap: 10px;">
                    <button onclick={handleCounterIncrement.with({ counter })}>
                      Increment
                    </button>
                    <button
                      onclick={handleRemoveCounter.with({ counter, counters })}
                    >
                      Remove
                    </button>
                  </div>
                </common-hstack>
              </common-vstack>
            </div>
          ))}
        </common-vstack>

        <common-hstack pad="md">
          <common-button onclick={handleAddCounter.with({ counters })}>
            Add Counter
          </common-button>
        </common-hstack>

        <common-hstack gap="lg">
          <div style="background: #f0f0f0; padding: 10px; border-radius: 5px;">
            <p>Total: {total}</p>
            <p>total plus 1: {derive(total, total => total + 1)}</p>
            <p>total minus 1: {derive(total, total => total - 1)}</p>
          </div>
        </common-hstack>
      </div>
    );
  }
}

const counters = new CountersSpell().compile("Counters");

export default counters;
