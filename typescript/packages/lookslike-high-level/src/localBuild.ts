import ts from 'typescript';
import * as commonHtml from "@commontools/common-html";
import * as commonBuilder from "@commontools/common-builder";
import * as commonRunner from "@commontools/common-runner";
import * as zod from "zod";


// NOTE(ja): this isn't currently doing typechecking, but it could...

// NOTE(ja): we should probably send JSON of graph, not the function... but...
// 1. unsure how to run a JSON graph from a recipe
// 2. converting to JSON loses closures (which is we will want, but we 
//    currently use closures to get around gaps in the current implementation)
export const buildRecipe = (src: string): { recipe?: commonBuilder.Recipe, errors?: string } => {
    if (!src) {
        return { errors: "No source code provided" }
    }

    // Custom module resolution
    const customRequire = (moduleName: string) => {
        switch (moduleName) {
            case "@commontools/common-html":
                return commonHtml;
            case "@commontools/common-builder":
                return commonBuilder;
            case "@commontools/common-runner":
                return commonRunner;
            case "zod":
                return zod;
            default:
                throw new Error(`Module not found: ${moduleName}`);
        }
    };

    // Add error handling for compilation
    const result = ts.transpileModule(src, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            strict: true,
            jsx: ts.JsxEmit.React,
            jsxFactory: 'h',
            jsxFragmentFactory: 'Fragment',
            esModuleInterop: true,
        },
        reportDiagnostics: true
    });

    // Check for compilation errors
    if (result.diagnostics && result.diagnostics.length > 0) {
        const errors = result.diagnostics.map(diagnostic => {
            const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
            let locationInfo = '';
            
            if (diagnostic.file && diagnostic.start !== undefined) {
                const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
                locationInfo = `[${line + 1}:${character + 1}] `; // +1 because TypeScript uses 0-based positions
            }
            
            return `Compilation Error: ${locationInfo}${message}`;
        }).join('\n');
        return { errors };
    }

    const js = result.outputText;

    try {
        // Wrap the transpiled code in a function that provides the custom require and mock exports
        const wrappedCode = `
            (function(require) {
                const exports = {};
                ${js}
                return exports;
            })(${customRequire.toString()})
        `;

        const { default: recipe } = eval(wrappedCode);
        return { recipe }
    } catch (e) {
        return { errors: (e as Error).message }
    }
};
