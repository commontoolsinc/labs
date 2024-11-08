import {
  UI,
  NAME,
  lift,
  handler,
  recipe,
  fetchData,
  llm,
  cell,
  ifElse,
} from "@commontools/common-builder";
import * as z from "zod";
import { zodSchemaQuery } from "../query.js";
import { h } from "@commontools/common-html";
import {
  prepDeleteRequest,
  prepInsertRequest,
  prepUpdateRequest,
} from "../mutation.js";

export const schema = z.object({
  sourceCode: z.string(),
  blendMode: z.string().optional(),
});

type ShaderItem = z.infer<typeof schema>;

const eid = (e: any) => (e as any)["."];

const onAddItem = handler<{}, { sourceCode: string }>((_e, state) => {
  const sourceCode = state.sourceCode;
  state.sourceCode = "";
  return fetchData(
    prepInsertRequest({ entity: { sourceCode, blendMode: "multiply" } }),
  );
});

const onGenerateShader = handler<{}, { prompt: string; triggerPrompt: string }>(
  (_e, state) => {
    state.triggerPrompt = state.prompt;
  },
);

const buildGeneration = lift(({ prompt }) => {
  return {
    messages: [
      prompt,
      `\`\`\`glsl
      precision mediump float;
      uniform float iTime;
      uniform vec2 iResolution;
      #define UV (gl_FragCoord.xy / iResolution);

      varying vec2 v_texCoord;

      `,
    ],
    system: "return a full, plain, glsl shader",
    stop: "```",
  };
});

const grabGLSL = lift<{ result?: string }, string | undefined>(({ result }) => {
  if (!result) {
    return;
  }
  const html = result.match(/```glsl\n([\s\S]+?)```/)?.[1];
  if (!html) {
    console.error("No GLSL found in text", result);
    return;
  }
  return html;
});

const onDeleteShader = handler<{}, { shader: ShaderItem }>((_, state) => {
  const shader = state.shader;
  return fetchData(prepDeleteRequest({ entity: shader, schema }));
});

const onUpdateShaderSource = handler<
  {},
  { shader: ShaderItem; newSource: string }
>((_e, state) => {
  const shader = state.shader;
  return fetchData(
    prepUpdateRequest({
      eid: eid(shader),
      attribute: "sourceCode",
      prev: shader.sourceCode,
      current: state.newSource,
    }),
  );
});

const onUpdateShaderBlendMode = handler<InputEvent, { shader: ShaderItem }>(
  (e, state) => {
    const shader = state.shader;
    return fetchData(
      prepUpdateRequest({
        eid: eid(shader),
        attribute: "blendMode",
        prev: shader.blendMode,
        current: (e.target as HTMLSelectElement)?.value || "multiply",
      }),
    );
  },
);

const copy = lift(({ value }: { value: any }) => value);
const stringify = lift((value: any) => JSON.stringify(value, null, 2));
const shaderEditor = recipe(
  z
    .object({
      shader: schema,
      sourceCode: z.string(),
      blendMode: z.string(),
    })
    .describe("Shader Editor"),
  ({ shader, sourceCode, blendMode }) => {
    const onCodeChange = handler<InputEvent, { newSource: string }>(
      (e, state) => {
        state.newSource = (e.target as HTMLInputElement).value;
      },
    );
    const newSource = cell("");

    const blendModes = [
      "multiply",
      "screen",
      "overlay",
      "darken",
      "lighten",
      "color-dodge",
      "color-burn",
      "hard-light",
      "soft-light",
      "difference",
      "exclusion",
    ];

    const onNextBlendMode = handler<
      {},
      { shader: ShaderItem; blendMode: string }
    >((_e, state) => {
      const currentIndex = blendModes.indexOf(state.blendMode || "multiply");
      const nextIndex = (currentIndex + 1) % blendModes.length;
      return fetchData(
        prepUpdateRequest({
          eid: eid(state.shader),
          attribute: "blendMode",
          prev: state.blendMode,
          current: blendModes[nextIndex],
        }),
      );
    });

    const onPrevBlendMode = handler<
      {},
      { shader: ShaderItem; blendMode: string }
    >((_e, state) => {
      const currentIndex = blendModes.indexOf(state.blendMode || "multiply");
      const prevIndex =
        (currentIndex - 1 + blendModes.length) % blendModes.length;
      return fetchData(
        prepUpdateRequest({
          eid: eid(state.shader),
          attribute: "blendMode",
          prev: state.blendMode,
          current: blendModes[prevIndex],
        }),
      );
    });

    return {
      [NAME]: eid(shader),
      [UI]: (
        <div>
          <textarea
            value={sourceCode}
            oninput={onCodeChange({ newSource })}
          ></textarea>
          <div>
            <button onclick={onPrevBlendMode({ shader, blendMode })}>
              Previous
            </button>
            <label>{blendMode}</label>
            <button onclick={onNextBlendMode({ shader, blendMode })}>
              Next
            </button>
          </div>
          <button onclick={onUpdateShaderSource({ shader, newSource })}>
            Save
          </button>
          <button onclick={onDeleteShader({ shader })}>Delete</button>
        </div>
      ),
      shader,
      sourceCode,
    };
  },
);

const ui = (uiComponent: any) => uiComponent[UI];

export const shaderQuery = recipe(
  z
    .object({
      focused: z.string(),
      prompt: z.string(),
      sourceCode: z.string(),
      triggerPrompt: z.string(),
    })
    .describe("shader query"),
  ({ sourceCode, prompt, triggerPrompt, focused }) => {
    const { result: items, query } = zodSchemaQuery(schema);

    const onCodeChange = handler<InputEvent, { sourceCode: string }>(
      (e, state) => {
        state.sourceCode = (e.target as HTMLInputElement).value;
      },
    );

    const onPromptChange = handler<InputEvent, { prompt: string }>(
      (e, state) => {
        state.prompt = (e.target as HTMLInputElement).value;
      },
    );

    const { result } = llm(buildGeneration({ prompt: triggerPrompt }));
    const hasResult = lift(({ result }) => !!result)({ result });

    return {
      [NAME]: "Shader query",
      [UI]: (
        <div style="width: 100%; height: 100%;">
          <div>
            <input
              type="string"
              value={prompt}
              placeholder="Prompt"
              oninput={onPromptChange({ prompt })}
            ></input>
            <textarea
              value={grabGLSL({ result })}
              placeholder="Shader source"
              oninput={onCodeChange({ sourceCode })}
            ></textarea>
            <button onclick={onGenerateShader({ prompt, triggerPrompt })}>
              Generate
            </button>
            <button onclick={onAddItem({ sourceCode: grabGLSL({ result }) })}>
              Add
            </button>
          </div>
          <details>
            <summary>All shaders</summary>
            <ul>
              {items.map((shader) => {
                return ui(
                  shaderEditor({
                    shader,
                    sourceCode: shader.sourceCode,
                    blendMode: shader.blendMode!,
                  }),
                );
              })}
            </ul>
          </details>
          <div style="position: relative; width: 100%; height: 100%;">
            {items.map(({ sourceCode, blendMode }) => {
              return (
                <shader-layer
                  width={640}
                  height={480}
                  shader={sourceCode}
                  blend-mode={blendMode}
                ></shader-layer>
              );
            })}
            {ifElse(
              hasResult,
              <shader-layer
                width={640}
                height={480}
                shader={grabGLSL({ result })}
              ></shader-layer>,
              <div></div>,
            )}
          </div>
        </div>
      ),
      data: items,
      query,
    };
  },
);
