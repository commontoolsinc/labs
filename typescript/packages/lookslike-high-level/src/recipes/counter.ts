import { html } from "@commontools/common-html";
import { recipe, NAME, UI, handler } from "@commontools/common-builder";

const inc = handler<{}, { count: { value: number } }>(
    ({ }, { count }) => { count.value = count.value + 1 }
);

const updateTitle = handler<{ detail: { value: string } }, { title: string }>(
    ({ detail }, state) => detail?.value && (state.title = detail.value)
);

export const counter = recipe<{ title: string; count: { value: number } }>(
    "counter",
    ({ title, count }) => {
        count.setDefault({ value: 0 });
        title.setDefault("untitled counter");

        return {
            [NAME]: title,
            [UI]: html`<div>
                         <common-input value=${title} placeholder="Counter title"
                           oncommon-input=${updateTitle({ title })}></common-input>
                         <p>${count.value}</p>
                         <button onclick=${inc({ count })}>Increment</button>
                       </div>`,
            count,
            title
        }
    })
