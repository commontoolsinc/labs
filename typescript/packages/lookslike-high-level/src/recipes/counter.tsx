import { h } from "@commontools/common-html";
import { Spell, type OpaqueRef } from "@commontools/common-builder";

type CounterState = {
  title: string;
  count: number;
};

export class CounterSpell extends Spell<CounterState> {
  constructor() {
    super();

    this.addEventListener("increment", self => {
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
        <common-button onclick={this.dispatch("increment")}>Increment</common-button>
      </div>
    );
  }
}

const counter = new CounterSpell().compile("Counter");

export default counter;