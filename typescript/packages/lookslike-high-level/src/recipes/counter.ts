import { html } from "@commontools/common-html";
import { recipe, NAME, UI, handler } from "@commontools/common-builder";

const incSynopsis = handler<{}, { count: number, synopsis: { "/": string } }>(
    ({ }, { count, synopsis }) => {

        let newValue = count + 1;

        fetch('///localhost:8080/', {
            method: 'PATCH',
            body: JSON.stringify([
                { Retract: [synopsis, 'count', count] },
                { Assert: [synopsis, 'count', newValue] },
            ])
        }).then(r => r.json()).then(data => {
            console.log('data', data)
        })
 
    }
);

const retitleSynopsis = handler<{}, { title: string, synopsis: { "/": string } }>(
    ({ }, { title, synopsis }) => {

        let newValue = `${title}.`;

        fetch('///localhost:8080/', {
            method: 'PATCH',
            body: JSON.stringify([
                { Retract: [synopsis, 'title', title] },
                { Assert: [synopsis, 'title', newValue] },
            ])
        }).then(r => r.json()).then(data => {
            console.log('data', data)
        })
 
    }
);


export const counter = recipe<{ title: string; count: number, synopsis: { "/": string } }>(
    "counter",
    ({ title, count, synopsis }) => {
        count.setDefault(0);
        title.setDefault("untitled counter");

        return {
            [NAME]: title,
            [UI]: html`<div>
                    <p>${title}</p>
                    <p>${count}</p>
                    <button onclick=${incSynopsis({ synopsis, count })}>Increment</button>
                    <button onclick=${retitleSynopsis({ synopsis, title })}>Retitle</button>
                </div>`,
            count,
            title,
            synopsis
        }
    })
