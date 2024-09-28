import { html } from "@commontools/common-html";
import {
    recipe,
    lift,
    generateData,
    handler,
    NAME,
    UI,
    str,
} from "@commontools/common-builder";
import { launch } from '../data.js';

const imageUrl = lift(
    ({ title }) =>
        `https://ct-img.m4ke.workers.dev/?prompt=${encodeURIComponent(title)}`,
)

const launcher = handler<{e: Event}, { title: string }>(
    ({ e }, { title }) => {
        console.log("launching", e, title);
        launch(prompt, { title });
    }
);

const updateTitle = handler<{ detail: { value: string } }, { title: string }>(
    ({ detail }, state) => { (state.title = detail?.value ?? "untitled") }
);

const maybeList = lift(({ result }) => result || []);

// FIXME(ja): if type Prompt is just a string, the render map fails
type Prompt = {
    prompt: string;
}

export const prompt = recipe<{ title: string }>("prompt", ({ title }) => {
    title.setDefault("abstract geometric art");
    const { result } = generateData<Prompt[]>({
        prompt: str`generate 10 image prompt variations for the current prompt: ${title}.  Some should change just the style, some should change the content, and some should change both. The last should be a completely different prompt.`,
        result: [],
        schema: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    prompt: {
                        type: "string",
                    },
                },
            },
        },
        mode: "json",
    });

    let src = imageUrl({ title });
    let variations = maybeList({result});

    return {
        [NAME]: title,
        [UI]: html`<common-vstack gap="sm">
            <common-input
                value=${title}
                placeholder="List title"
                oncommon-input=${updateTitle({ title })}
            ></common-input>
            <img src=${src}} width="100%" />
            <ul>${variations.map(({ prompt }) => html`<li>${prompt} - <span onclick=${launcher({ title: prompt })}>⏩</span></li>`)}</ul>
        </common-vstack>`,
        title,
        variations: result,
    };
});