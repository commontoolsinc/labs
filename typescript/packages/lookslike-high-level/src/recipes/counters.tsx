import { h } from "@commontools/common-html";
import {
  Spell,
  type OpaqueRef,
  handler,
  select,
  $,
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

const incrementHandler = handler<{}, { counter: Counter }>(function (
  {},
  { counter },
) {
  console.log("incrementHandler", counter);
  counter.count += 1;
});

const renameHandler = handler<
  { detail: { value: string } },
  { counter: Counter }
>(function ({ detail: { value } }, { counter }) {
  counter.title = value;
});

const removeHandler = handler<{}, { counter: Counter; counters: Counter[] }>(
  function ({}, { counter, counters }) {
    console.log("removeHandler", counter, counters);
    // FIXME(ja): not having equality check on objects is a problem
    const index = counters.findIndex(
      i => i.title === counter.title && i.count === counter.count,
    );
    if (index !== -1) {
      counters.splice(index, 1);
    }
  },
);

export class CountersSpell extends Spell<Counters> {
  constructor() {
    super();

    this.addEventListener("title", (self, { detail: { value } }) => {
      self.title = value;
    });

    this.addEventListener("add", self => {
      self.counters.push({
        title: "untitled counter " + self.counters.length,
        count: 0,
      });
    });

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
      <div>
        <common-input value={title} oncommon-input={this.dispatch("title")} />
        {counters.map(counter => (
          <div>
            <common-input
              value={counter.title}
              oncommon-input={renameHandler.with({ counter })}
            />
            {counter.count}
            <button onclick={incrementHandler.with({ counter })}>
              Increment
            </button>
            <button onclick={removeHandler.with({ counter, counters })}>
              Remove
            </button>
          </div>
        ))}
        <p>Total: {total}</p>
        <common-button onclick={this.dispatch("add")}>Add</common-button>
      </div>
    );
  }
}

const counters = new CountersSpell().compile("Counters");

export default counters;
