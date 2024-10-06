import { html } from "@commontools/common-html";
import { recipe, NAME, UI, handler, lift, generateText } from "@commontools/common-builder";


const updateValue = handler<{ detail: { value: string } }, { value: string }>(
    ({ detail }, state) => { detail?.value && (state.value = detail.value); }
);

const generateTextMessages = lift(({ textprompt }) => {
    return textprompt && [textprompt, 'It was']
});

const generateJSONMessages = lift(({ jsonprompt }) => {
    return jsonprompt && [jsonprompt, '```json\n{']
});

const generateHTMLMessages = lift(({ htmlprompt }) => {
    return htmlprompt && [htmlprompt, '```html\n<html>']
});

const grabText = lift(({ result, partial, pending }) => {
    if (pending) {
        return partial || ''
    }
    return result
})    

const grabJson = lift(({ result }) => {
    if (!result) {
        return {};
    }
    const jsonMatch = result.match(/```json\n([\s\S]+?)```/);
    if (!jsonMatch) {
        console.log("No JSON found in text:", result);
        return {};
    }
    return JSON.parse(jsonMatch[1]);
})

const grabHtml = lift(({ result, partial, pending }) => {
    console.log({partial, pending})
    if (pending) {
        if (!partial) { 
            return ""
        }
        console.log(partial);
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

const jsonify = lift(({ data }) => JSON.stringify(data, null, 2))

export const generator = recipe<{ jsonprompt: string; htmlprompt: string; textprompt: string; data: any }>(
    "data generator",
    ({ jsonprompt, htmlprompt, textprompt, data }) => {

        textprompt.setDefault("2 sentence story");
        const { result: textResult, partial: textPartial, pending: textPending } = generateText({
            messages: generateTextMessages({ textprompt }),
            system: "You are a helpful assistant that generates text for testing.  Respond in text"
        });
        const maybeText = grabText({ result: textResult, partial: textPartial, pending: textPending });

        jsonprompt.setDefault("pet");
        const { result: jsonResult } = generateText({
            messages: generateJSONMessages({ jsonprompt }),
            system: "You are a helpful assistant that generates JSON objects for testing.  Respond in JSON",
            stop: '```'
        });
        data = grabJson({ result: jsonResult });
        const maybeJSON = jsonify({ data });

        htmlprompt.setDefault("simple html about recipes");
        const { result: htmlResult, partial: htmlPartial, pending: htmlPending } = generateText({
            messages: generateHTMLMessages({ htmlprompt }),
            system: "You are a helpful assistant that generates HTML for testing.  Respond in HTML",
            stop: '```'
        });
        const maybeHTML = grabHtml({ result: htmlResult, partial: htmlPartial, pending: htmlPending });

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
