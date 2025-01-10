import { h } from "@commontools/common-html";
import { Spell, type OpaqueRef, handler } from "@commontools/common-builder";

type CounterState = {
  title: string;
  count: number;
};

const thisHandler = handler<{}, { count: number }>(function () {
  this.count += 1;
});

const withHandler = handler<{}, { count: number }>(function ({}, state) {
  state.count += 1;
});

export class CounterSpell extends Spell<CounterState> {
  constructor() {
    super();

    this.addEventListener("increment", self => {
      console.log("self", self);
      const { count } = self;
      this.update(self, { count: count + 1 });
    });

    this.addEventListener("title", (self, { detail: { value } }) => {
      this.update(self, { title: value });
    });
  }

  override init() {
    return {
      title: "untitled counter",
      count: 0,
    };
  }

  override render({ title, count }: OpaqueRef<CounterState>) {
    return (
      <div>
        <common-input value={title} oncommon-input={this.dispatch("title")} />
        <p>count: {count}</p>
        <common-button onclick={this.dispatch("increment")}>
          dispatch
        </common-button>
        <common-button onclick={thisHandler.bind({ count })}>
          this
        </common-button>
        <common-button onclick={withHandler.with({ count })}>
          with
        </common-button>
      </div>
    );
  }
}

const counter = new CounterSpell().compile("Counter");

export default counter;
