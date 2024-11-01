import { h } from "@commontools/common-html";
import { recipe, NAME, UI, handler, lift, llm, fetchData, ifElse } from "@commontools/common-builder";
import { z } from "zod";
import { schemaQuery, eid } from "../query.js";
import { prepDeleteRequest, prepInsertRequest, prepUpdateRequest } from "../mutation.js";



const deleteItem = handler<{}, { item: Picture }>((e, state) => {
    console.log("deleteItem", state);
    return fetchData(prepDeleteRequest({ entity: state.item, schema: Picture }));
})

const add = handler<{ detail: { value: string, key: string } }, {}>(
    ({ detail }, { }) => {
        console.log("add", detail);
        if (detail?.key !== "Enter") return;
        const prompt = detail.value;
        return fetchData(
            prepInsertRequest({
                entity: {
                    prompt: prompt,
                }
            }),
        );
    }
);

const genImage = lift(({ prompt }) => `/api/img/?prompt=${encodeURIComponent(prompt)}`);

const tap = lift((x) => { console.log(JSON.stringify(x, null, 2)) });

const LatentExplorer = z.object({
    prompts: z.array(z.string()).default([]),
}).describe("Latent explorer");
type LatentExplorer = z.infer<typeof LatentExplorer>;

const Picture = z.object({
    prompt: z.string(),
}).describe("Picture");
type Picture = z.infer<typeof Picture>;

const picture = recipe(Picture, ({ prompt, item }) => {
    return {
        [NAME]: "prompt",
        [UI]: <span class="item">
            <img src={genImage({ prompt })} width="200" height="200" />
            <button onclick={deleteItem({ item })}>Remove</button>
        </span>
    }
});

export const latentExplorer = recipe(LatentExplorer,
    ({ prompts }) => {

        const { result, query } = schemaQuery(Picture)

        // const suggestions = grabSuggestions(llm(prepSuggestions({ prompts })));
        tap({ result })

        return {
            [NAME]: "Latent Explorer",
            [UI]: <os-container>
                <style type="text/css">
                    {`
                    .item {
                        display: inline-block;
                        background-color: #f0f0f0;
                        margin: 10px;
                        position: relative;
                    }
                    .item button {
                        display: none;
                    }
                    .item:hover button {
                        display: block;
                        position: absolute;
                        top: 5px;
                        right: 5px;
                        background-color: rgba(255, 255, 255, 0.7);
                        border: none;
                        padding: 5px 10px;
                        cursor: pointer;
                    }
                  `}
                </style>
                <common-input
                    placeholder="prompt"
                    oncommon-keydown={add({ prompts })} />
                {
                    result.map((item) => picture({ prompt: item.prompt, item })[UI])
                }
            </os-container>,
            query,
            data: result,
            // suggestions: { items: suggestions },
        }
    });