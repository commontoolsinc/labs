import { html } from "@commontools/common-html";
import { recipe, UI, NAME, handler, } from "@commontools/common-builder";
import ts from 'typescript';
import * as commonHtml from "@commontools/common-html";
import * as commonBuilder from "@commontools/common-builder";
import * as commonRunner from "@commontools/common-runner";
import * as commonData from "../data.js";

const runCode = handler<{}, { src: string, output: string }>(
    (_, state) => {
        // Custom module resolution
        const customRequire = (moduleName: string) => {
            switch (moduleName) {
                case "@commontools/common-html":
                    return commonHtml;
                case "@commontools/common-builder":
                    return commonBuilder;
                case "@commontools/common-runner":
                    return commonRunner;
                case "../data.js":
                    return commonData;
                default:
                    throw new Error(`Module not found: ${moduleName}`);
            }
        };

        const result = ts.transpileModule(state.src, {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2015,
            }
        });

        const logs: string[] = [];
        const originalLog = console.log;
        console.log = (...args) => {
            logs.push(args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' '));
        };

        // Wrap the transpiled code in a function that provides the custom require and mock exports
        const wrappedCode = `
            (function(require) {
                const exports = {};
                ${result.outputText}
                return exports;
            })(${customRequire.toString()})
        `;

        const moduleExports = eval(wrappedCode);
        console.log('Module exports:', JSON.stringify(moduleExports, null, 2));

        console.log = originalLog;
        console.log(logs);

        state.output = logs.join('\n');
    }
);

const updateTitle = handler<{ detail: { value: string } }, { title: string }>(
    ({ detail }, state) => { (state.title = detail?.value ?? "untitled") }
);

export const coder = recipe<{ title: string, src: string, output: string }>("code", ({ title, src, output }) => {

    // FIXME(ja): typing into the textarea doesn't update the src!  Do we have a pattern
    // for keeping a textarea in sync with its value?
    return {
        [NAME]: title,
        [UI]: html`<common-vstack gap="sm">
            <common-input
                value=${title}
                placeholder="title"
                oncommon-input=${updateTitle({ title })}
            ></common-input>
            
            <textarea
                value=${src}
                rows="15"
                placeholder="src"
            ></textarea>
            <common-button onclick=${runCode({ src, output })}>Run</common-button>
            <pre>${output}</pre>
        </common-vstack>`,
        title,
        src,
    };
});
