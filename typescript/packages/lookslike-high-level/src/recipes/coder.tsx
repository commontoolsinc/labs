import { h, } from "@commontools/common-html";
import { recipe, NAME, UI, handler, lift, cell, ifElse, navigateTo } from "@commontools/common-builder";
import { buildRecipe } from "../localBuild.js";

const build = lift<{ src: string, recipe: any, errors: string }>((state) => {
    if (state.src) {
        const newRecipe = buildRecipe({ src: state.src })
        if ("errors" in newRecipe) {
            state.errors = newRecipe.errors
            state.recipe = {}
        } else {
            // NOTE(ja): we should probably send the JSON graph, not the function... but...
            // 1. I'm not sure how to run it from this recipe then
            // 2. converting to JSON loses closures (which is good, but we 
            //    use them to get around holes in the current implementation)
            // state.recipe = JSON.parse(JSON.stringify(newRecipe.recipe))
            state.recipe = newRecipe.recipe
            state.errors = ""
        }
    }
    console.log("build", state.src, state.errors, state.recipe)
})

const run = handler<{  }, { recipe: any }>(({ }, state) => {
    const data = {}; // FIXME(ja): this should be sent ...
    return navigateTo(state.recipe(data))
})

const jsonify = lift(({ recipe }) => JSON.stringify(recipe, null, 2))

export const coder = recipe<{
    src: string;
    errors: string;
}>("coder", ({ src }) => {

    const recipe = cell({})
    const errors = cell("")

    build({ src, recipe, errors })

    return {
        [UI]: <os-container>
            <h2>Coder</h2>
            {ifElse(
                errors,
                <pre>${errors}</pre>,
                <span></span>
            )}
            {ifElse(
                errors,
                <span></span>,
                <div>
                    <button onclick={run({ recipe })}>Run</button>
                    <pre>{jsonify({ recipe })}</pre>
                </div>
            )}
        </os-container>,
        [NAME]: "coder",
        recipeSrc: src,
    }
})
