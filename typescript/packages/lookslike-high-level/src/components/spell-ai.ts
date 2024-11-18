import { LLMClient } from "@commontools/llm-client";

const llmUrl = typeof window !== "undefined"
    ? window.location.protocol + "//" + window.location.host + "/api/llm"
    : "//api/llm";

const llm = new LLMClient(llmUrl);

export const llmTweakSpec = async (
    { spec, change }: { spec: string; change: string }
) => {
    const payload = {
        model: "anthropic:claude-3-5-sonnet-latest",
        system: "You are a spec editor for @commontools recipes.  Please respond with the full spec.",
        messages: [
            'what is the current spec?',
            `\`\`\`markdown\n${spec}\n\`\`\``,
            `The user asked you to update the spec by the following:
\`\`\`
${change}
\`\`\`

RESPOND WITH THE FULL SPEC.  Try to keep the same structure, style and content as the original spec except for the changes requested.
`,
            `\`\`\`markdown\n`,
        ],
        stop: "\n```",
    };

    const text = await llm.sendRequest(payload);
    return text.split("```markdown\n")[1].split("\n```")[0];
};

export const iterate = async (
    { errors, originalSpec, originalSrc, workingSpec, workingSrc }: {
        errors?: string;
        originalSpec?: string;
        originalSrc?: string;
        workingSpec?: string;
        workingSrc?: string;
    } = {},
) => {
    const messages = [];
    let prefill = `\`\`\`tsx\n`;

    if (errors) {
        if (originalSpec && originalSrc) {
            messages.push(workingSpec || originalSpec);
            messages.push(`\`\`\`tsx\n${workingSrc || originalSrc}\n\`\`\``);
        }
        messages.push(`The user asked you to fix the following:
\`\`\`
${errors}
\`\`\`

RESPOND WITH THE FULL SOURCE CODE
`);
        messages.push(prefill);
    } else {
        if (originalSpec && originalSrc) {
            messages.push(originalSpec);
            messages.push(`\`\`\`tsx\n${originalSrc}\n\`\`\``);
        }

        if (workingSrc?.includes("//PREFILL")) {
            console.log("PREFILL in src");
            prefill += workingSrc.split("//PREFILL")[0];
        }

        if (workingSpec && workingSrc) {
            messages.push(workingSpec);
            messages.push(prefill);
        }
    }

    const payload = {
        model: "anthropic:claude-3-5-sonnet-latest",
        system: "You are code generator that implements @commontools recipes.",
        messages,
        stop: "\n```",
    };

    const text = await llm.sendRequest(payload);
    return text.split("```tsx\n")[1].split("\n```")[0];
};
