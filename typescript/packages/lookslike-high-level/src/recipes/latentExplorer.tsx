import { h } from "@commontools/common-html";
import { recipe, NAME, UI, handler, lift, llm } from "@commontools/common-builder";
import { z } from "zod";

const add = handler<{ detail: { value: string, key: string } }, { prompts: string[] }>(
    ({ detail }, state) => {
        console.log("add", detail);
        detail?.key === "Enter" && detail?.value && state.prompts.push(detail.value);
    }
);

const remove = handler<{}, { prompt: string, prompts: string[] }>(
    ({ }, state) => {
        const index = state.prompts.findIndex((p) => p === state.prompt);
        if (index !== -1) {
            state.prompts.splice(index, 1);
        }
    }
);

const genImage = lift(({ prompt }) => `/api/img/?prompt=${encodeURIComponent(prompt)}`);

const addToPrompt = handler<
    { prompt: string },
    { prompts: string[] }
>((e, state) => {
    state.prompts.push(e.prompt);
});

const tap = lift((x) => { console.log(JSON.stringify(x, null, 2)) });

const LatentExplorer = z.object({
    prompts: z.array(z.string()).default([]),
}).describe("Latent explorer");
type LatentExplorer = z.infer<typeof LatentExplorer>;

const Picture = z.object({
    prompt: z.string(),
}).describe("Picture");
type Picture = z.infer<typeof Picture>;

const picture = recipe(Picture, ({ prompt, remove }) => {
    return {
        [NAME]: "prompt",
        [UI]: <span>
            <img src={genImage({ prompt })} width="200" height="200" style="border: 10px solid black;" />
            <button onclick={remove}>Remove</button>
        </span>
    }
});

export const latentExplorer = recipe(LatentExplorer,
    ({ prompts }) => {

        // const suggestions = grabSuggestions(llm(prepSuggestions({ prompts })));
        // tap({ recipes });

        return {
            [NAME]: "Latent Explorer",
            [UI]: <os-container>
                <common-input
                    placeholder="prompt"
                    oncommon-keydown={add({ prompts })} />
                {prompts.map((prompt) => picture({ prompt, remove: remove({ prompts, prompt }) })[UI])}
            </os-container>,
            addToPrompt: addToPrompt({ prompts }),
            // suggestions: { items: suggestions },
        }
    });