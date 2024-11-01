import { h } from "@commontools/common-html";
import { recipe, NAME, UI, handler, lift, llm, fetchData, ifElse } from "@commontools/common-builder";
import { z } from "zod";
import { schemaQuery, buildTransactionRequest } from "../query.js";

const eid = (e: any) => (e as any)['.'];

const prepChanges = lift(({ prompt }) => {
    return 
});

const deleteItem = handler<{}, { item: Picture }>((e, state) => {
    console.log("deleteItem", state);
    return fetchData(buildTransactionRequest({
        changes: [
            {
                Retract: [eid(state.item), "prompt", state.item.prompt],
            },
        ]
    }));
})

const add = handler<{ detail: { value: string, key: string } }, {}>(
    ({ detail }, { }) => {
        console.log("add", detail);
        if (detail?.key !== "Enter") return;
        return fetchData(buildTransactionRequest({
            changes: [
                {
                    Import: {
                        prompt: detail.value
                    }
                }
            ]
        }));
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
        [UI]: <span>
            <p>{prompt}</p>
            <img src={genImage({ prompt })} width="200" height="200" style="border: 10px solid black;" />
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