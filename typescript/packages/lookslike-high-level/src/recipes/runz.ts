import { html } from "@commontools/common-html";
import { recipe, UI, NAME, handler, fetchData, str, lift } from "@commontools/common-builder";
import { launch } from "../data.js";
import ts from 'typescript';
import * as commonHtml from "@commontools/common-html";
import * as commonBuilder from "@commontools/common-builder";
import * as commonRunner from "@commontools/common-runner";
import * as commonData from "../data.js";
import { virtualTypeDefs } from '../virtualTypeDefs.js'; // Adjust the path as necessary

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

        console.log('virtualTypeDefs', virtualTypeDefs);

        // Virtual Files
        const virtualFiles: { [fileName: string]: string } = virtualTypeDefs;

        // Create a virtual TypeScript compiler host
        const compilerHost: ts.CompilerHost = {
            fileExists: (fileName) => {
                console.log('fileExists', fileName, fileName in virtualFiles, fileName === "file.ts");
                return fileName in virtualFiles || fileName === "file.ts";
            },
            getCanonicalFileName: (fileName) => fileName,
            getCurrentDirectory: () => "",
            getDirectories: () => [],
            getDefaultLibFileName: () => "lib.es2015.d.ts",
            getNewLine: () => "\n",
            getSourceFile: (fileName, languageVersion) => {
                if (fileName === "file.ts") {
                    return ts.createSourceFile(fileName, state.src, languageVersion, true);
                }
                if (fileName in virtualFiles) {
                    return ts.createSourceFile(fileName, virtualFiles[fileName], languageVersion, true);
                }
                return undefined;
            },
            readFile: (fileName) => virtualFiles[fileName] || "",
            useCaseSensitiveFileNames: () => true,
            writeFile: () => {}
        };

        const compilerOptions: ts.CompilerOptions = {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2015,
            noEmitOnError: true,
            strict: true,
            lib: ["lib.es2015.d.ts", "lib.dom.d.ts"],
        };

        const program = ts.createProgram(["file.ts"], compilerOptions, compilerHost);

        const diagnostics = ts.getPreEmitDiagnostics(program);

        if (diagnostics.length > 0) {
            const errorMessages = diagnostics.map(diag => {
                const message = ts.flattenDiagnosticMessageText(diag.messageText, "\n");
                if (diag.file && diag.start !== undefined) {
                    const { line, character } = diag.file.getLineAndCharacterOfPosition(diag.start);
                    return `Error ${diag.file.fileName} (${line + 1},${character + 1}): ${message}`;
                }
                return `Error: ${message}`;
            }).join("\n");

            console.log('errorMessages', errorMessages);

            state.output = errorMessages;
            return;
        }

        // Transpile the code since there are no type errors
        const result = ts.transpileModule(state.src, {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2015,
                noEmitOnError: true,
                strict: true,
            }
        });

        const logs: string[] = [];
        // const originalLog = console.log;
        // console.log = (...args) => {
            // logs.push(args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' '));
        // };

        try {
            // Wrap the transpiled code in a function that provides the custom require and mock exports
            const wrappedCode = `
                (function(require) {
                    const exports = {};
                    ${result.outputText}
                    return exports;
                })(${customRequire.toString()})
            `;

            const moduleExports = eval(wrappedCode);
            launch(moduleExports.counters, {})
            logs.push('Module exports:', JSON.stringify(moduleExports, null, 2));
        } catch (e) {
            console.log('Runtime Error:', e.message);
        }

        // console.log = originalLog;
        state.output = logs.join('\n')
    }
);

const updateHash = handler<{ detail: { value: string } }, { hash: string }>(
    ({ detail }, state) => { (state.hash = detail?.value ?? "untitled") }
);


export const runz = recipe<{ hash: string, output: string }>("run code", ({ hash, output }) => {

    const url = str`https://commoner.m4ke.workers.dev/${hash}`;
    const { result: src } = fetchData<string>({ url, mode: "text" });

    return {
        [NAME]: "run code",
        [UI]: html`<common-vstack gap="sm">
            <common-input
                value=${hash}
                placeholder="hash"
                oncommon-input=${updateHash({ hash })}
            ></common-input>
            
            <h2>src</h2>
            <pre>${src}</pre>
            <common-button onclick=${runCode({ src, output })}>Run</common-button>

            <h2>output</h2>
            <pre>${output}</pre>
        </common-vstack>`,
    };
});