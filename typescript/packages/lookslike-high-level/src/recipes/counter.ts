import { html } from "@commontools/common-html";
import { recipe, NAME, UI, handler } from "@commontools/common-builder";

// FIXME(ja): we need counter to be a non-literal otherwise updates don't work #144
const inc = handler<{}, { count: { value: number } }>(
    ({}, { count }) => { count.value += 1; }
);

const updateValue = handler<{ detail: { value: string } }, { value: string }>(
    ({ detail }, state) => detail?.value && (state.value = detail.value)
);

export const counter = recipe<{ title: string; count: { value: number } }>(
    "counter",
    ({ title, count }) => {
        count.value.setDefault(0);
        title.setDefault("untitled counter");

        return {
            [NAME]: title,
            [UI]: html`<div>
                    <common-input value=${title} placeholder="Name of counter" oncommon-input=${updateValue({ value: title })}></common-input>
                    <p>${count.value}</p>
                    <button onclick=${inc({ count })}>Inc</button>
                </div>`,
            count
        }
    })
