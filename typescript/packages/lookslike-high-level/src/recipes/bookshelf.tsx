import { h } from "@commontools/common-html";
import { recipe, NAME, UI, handler, lift, llm, cell, ifElse } from "@commontools/common-builder";
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

const Book = z.object({
    title: z.string(),
    author: z.string(),
    description: z.string(),
});
type Book = z.infer<typeof Book>;

const prepJSON = lift(({ data }) => {
    if (!data) {
        return {};
    }

    const jsonSchema = JSON.stringify(zodToJsonSchema(Book), null, 2);

    return {
        messages: [{
            role: "user", content: [
                { type: "text", text: "my bookshelf" },
                { type: "image", image: data }
            ]
        },
        { role: "assistant", content: '```json\n[\n{"title": "' }],
        system: `Generate a list of all the books captured in the picture sent by the user:\n\n<schema>${jsonSchema}</schema>`,
        stop: '```'
    }
});
const grabJson = lift<{ result?: string, pending?: boolean }, { pending: boolean, data: Book[] }>(
    ({ result, pending }) => {
        if (pending) {
            return { pending: true, data: [] };
        }
        if (!result) {
            return { pending: false, data: [] };
        }
        const jsonMatch = result.match(/```json\n([\s\S]+?)```/);
        if (!jsonMatch) {
            console.error("No JSON found in text:", result);
            return { pending: false, data: [] };
        }
        let rawData = JSON.parse(jsonMatch[1]);
        let parsedData = Book.array().safeParse(rawData);
        if (!parsedData.success) {
            console.error("Invalid JSON:", parsedData.error);
            return { pending: false, data: [] };
        }
        return { pending: false, data: parsedData.data };
    })

const jsonify = lift(({ data }) => JSON.stringify(data, null, 2))

const loadData = handler<{ detail: { filesContent } }, { data: any }>(
    ({ detail: { filesContent } }, state) => {
        state.data = filesContent[0].content;
    });

export const bookshelf = recipe(
    "bookshelf",
    ({ }) => {
        const data = cell("")
        const { pending, data: books } = grabJson(llm(prepJSON({ data })));

        return {
            [NAME]: 'Bookshelf',
            [UI]: <div>
                <common-file-input
                    accept=".jpg,.jpeg,.png"
                    loadMode="base64"
                    oncommon-file-input={loadData({ data })}
                ></common-file-input>

                {ifElse(pending,
                    <span>Loading...</span>,
                    <pre>{jsonify({ data: books })}</pre>)}
            </div>,
            data: books
        }
    })
