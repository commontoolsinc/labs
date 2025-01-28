import { h } from "@commontools/html";
import { Spell, type OpaqueRef, handler } from "@commontools/builder";

type CounterState = {
  title: string;
  count: number;
};


const withHandler = handler<{}, { count: number }>(function ({}, state) {
  state.count += 1;
});

export class CounterSpell extends Spell<CounterState> {
  constructor() {
    super();

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
        <common-button onclick={withHandler.with({ count })}>with</common-button>
      </div>
    );
  }
}

const counter = new CounterSpell().compile("Counter");

export default counter;
