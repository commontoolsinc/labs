import { h, } from "@commontools/common-html";
import { recipe, NAME, UI, handler, lift, cell, ifElse, navigateTo, derive } from "@commontools/common-builder";
import { buildRecipe } from "../localBuild.js";


const run = handler<{}, { recipe: any }>(({ }, state) => {
    const data = {}; // FIXME(ja): this should be sent ...
    return navigateTo(state.recipe(data))
})

const jsonify = lift(({ recipe }) => JSON.stringify(recipe, null, 2))

export const coder = recipe<{
    src: string;
}>("coder", (state) => {


    const { recipe, errors } = derive(state.src, (src) => buildRecipe(src))

    return {
        [UI]: <os-container>
            <h2>Coder</h2>
            {ifElse(
                errors,
                <pre>${errors}</pre>,
                ifElse(
                    recipe,
                    <div>
                        <button onclick={run({ recipe })}>Run</button>
                        <os-code-editor source={jsonify({ recipe })}
                            language="application/json"></os-code-editor>
                    </div>,
                    <span>no recipe graph.. are you missing the default export?</span>
                ))
            }
        </os-container>,
        [NAME]: "coder",
        recipeSrc: state.src,
    }
})
