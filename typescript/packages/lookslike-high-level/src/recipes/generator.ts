import { html } from "@commontools/common-html";
import { recipe, NAME, UI, handler, lift, generateText } from "@commontools/common-builder";
import { z } from 'zod';
import zodToJsonSchema from 'zod-to-json-schema';

const updateValue = handler<{ detail: { value: string } }, { value: string }>(
    ({ detail }, state) => { detail?.value && (state.value = detail.value); }
);


const prepText = lift(({ prompt }) => {
    if (prompt) {
        return {
            messages: [prompt, 'It was'],
            system: "You are a helpful assistant that generates text for testing.  Respond in text"
        }
    }
    return {};
});
const grabText = lift(({ result, partial, pending }) => {
    if (pending) {
        return partial || ''
    }
    return result
})


const prepHTML = lift(({ prompt }) => {
    if (prompt) {
        return {
            messages: [prompt, '```html\n<html>'],
            system: "You are a helpful assistant that generates HTML for testing.  Respond in HTML",
            stop: '```'
        }
    }
    return {};
});
const grabHtml = lift(({ result, partial, pending }) => {
    if (pending) {
        if (!partial) {
            return ""
        }
        return partial.replace(/</g, "&lt;").replace(/>/g, "&gt;").slice(-1000);
    }

    if (!result) {
        return "";
    }

    const html = result.match(/```html\n([\s\S]+?)```/)?.[1];
    if (!html) {
        console.error("No HTML found in text", result);
        return "";
    }
    return html
});


const Character = z.object({
    name: z.string(),
    class: z
        .string()
        .describe('Character class, e.g. warrior, mage, or thief.'),
    description: z.string(),
});
type Character = z.infer<typeof Character>;

const prepJSON = lift(({ prompt }) => {
    const jsonSchema = JSON.stringify(zodToJsonSchema(Character), null, 2);

    if (prompt) {
        return {
            messages: [prompt, '```json\n{'],
            system: `Generate character data inspired by the user description using JSON:\n\n<schema>${jsonSchema}</schema>`,
            stop: '```'
        }
    }
    return {};
});
const grabJson = lift<{ result: string }, Character | undefined>(({ result }) => {
    if (!result) {
        return;
    }
    const jsonMatch = result.match(/```json\n([\s\S]+?)```/);
    if (!jsonMatch) {
        console.error("No JSON found in text:", result);
        return;
    }
    let rawData = JSON.parse(jsonMatch[1]);
    let parsedData = Character.safeParse(rawData);
    if (!parsedData.success) {
        console.error("Invalid JSON:", parsedData.error);
        return;
    }
    return parsedData.data;
})
const jsonify = lift(({ data }) => JSON.stringify(data, null, 2))

export const generator = recipe<{ jsonprompt: string; htmlprompt: string; textprompt: string; data: Character | undefined }>(
    "data generator",
    ({ jsonprompt, htmlprompt, textprompt, data }) => {

        textprompt.setDefault("2 sentence story");
        const maybeText = grabText(generateText(prepText({ prompt: textprompt })))

        jsonprompt.setDefault("pet");
        data = grabJson(generateText(prepJSON({ prompt: jsonprompt })));
        const maybeJSON = jsonify({ data });

        htmlprompt.setDefault("simple html about recipes");
        const maybeHTML = grabHtml(generateText(prepHTML({ prompt: htmlprompt })));

        return {
            [NAME]: 'data generator',
            [UI]: html`<div>
                            <p>Text</p>
                            <common-input
                            value=${textprompt}
                            placeholder="Request to LLM"
                            oncommon-input=${updateValue({ value: textprompt })}
                            ></common-input>
                            <p>${maybeText}</p>

                            <p>JSON</p>
                            <common-input
                            value=${jsonprompt}
                            placeholder="Request to LLM"
                            oncommon-input=${updateValue({ value: jsonprompt })}
                            ></common-input>
                            <pre>${maybeJSON}</pre>

                            <p>HTML</p>
                            <common-input
                            value=${htmlprompt}
                            placeholder="Request to LLM"
                            oncommon-input=${updateValue({ value: htmlprompt })}
                            ></common-input>
                            <common-iframe src=${maybeHTML}></common-iframe>
                        </div>`,
            prompt,
            data
        }
    })
