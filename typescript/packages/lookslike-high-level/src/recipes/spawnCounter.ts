import { html } from "@commontools/common-html";
import { recipe, NAME, UI, handler, lift } from "@commontools/common-builder";
import * as DB from "datalogia"

const jsonify = lift((x: any) => JSON.stringify(x, null, 2));

const updateTitle = handler<{ detail: { value: string } }, { title: string }>(
    ({ detail }, state) => detail?.value && (state.title = detail.value)
);

const updateCount = handler<{ detail: { value: string } }, { count: number }>(
    ({ detail }, state) => detail?.value && (state.count = parseInt(detail.value))
);

const spawn = handler<void, { title: string; count: number }>((_, { title, count }) => {

    console.log('spawn', title)

    let id = DB.Link.of({ title, recipe: "counter" })

    fetch('///localhost:8080/', {
        method: 'PATCH',
        body: JSON.stringify([
            { Assert: [id, 'title', title] },
            { Assert: [id, 'count', count]}
        ])
    }).then(r => r.json()).then(data => {
        console.log('data', data)
    })
});


export const spawnCounter = recipe<{ title: string, count: number }>(
    "spawnCounter",
    ({ title, count }) => {
        title.setDefault("counter");
        count.setDefault(0);

        return {
            [NAME]: "Spawn Counter",
            [UI]: html`<div>
         <common-input
           value=${title}
           placeholder="List title"
          oncommon-input=${updateTitle({ title })}
         ></common-input>
                  <common-input
           value=${count}
           placeholder="List title"
          oncommon-input=${updateCount({ count })}
         ></common-input>
         <common-button
          onclick=${spawn({ title, count })}
         >Spawn Counter</common-button>
                </div>`,
            count,
            title,
        }
    })
