import { html } from "@commontools/common-html";
import { recipe, NAME, UI, handler } from "@commontools/common-builder";

const inc = handler<{}, { count: { value: number } }>(({}, state) => {
  state.count.value += 1;
});

const updateValue = handler<{ detail: { value: string } }, { value: string }>(
  ({ detail }, state) => {
    detail?.value && (state.value = detail.value);
  }
);

export const counter = recipe<{ title: string; count: { value: number } }>(
  "counter",
  ({ title, count }) => {
    count.setDefault({ value: 0 });
    title.setDefault("untitled counter");

    return {
      [NAME]: title,
      [UI]: html`<div>
        <common-input
          value=${title}
          placeholder="Name of counter"
          oncommon-input=${updateValue({ value: title })}
        ></common-input>
        <p>${count}</p>
        <button onclick=${inc({ count })}>Inc</button>
      </div>`,
      count,
    };
  }
);
