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
import { buildTransactionRequest, schemaQuery } from "../query.js";
import { h } from "@commontools/common-html";

export const schema = z.object({
  sourceCode: z.string()
})

type ShaderItem = z.infer<typeof schema>;

const eid = (e: any) => (e as any)['.'];

const onAddItem = handler<{}, { sourceCode: string }>((e, state) => {
  const sourceCode = state.sourceCode;
  state.sourceCode = '';
  return fetchData(buildTransactionRequest(prepChanges({ sourceCode })));
})

const prepChanges = lift(({ sourceCode }) => {
  return {
    changes: [
      {
        Import: {
          sourceCode
        }
      }
    ]
  }
})

const prepGeneration = lift(({ prompt }) => {
  return {
    messages: [prompt],
    system: "test"
  }
})

const onGenerateShader = handler<{}, { prompt: string; triggerPrompt: string; }>((e, state) => {
  state.triggerPrompt = state.prompt;
})

const buildGeneration = lift(({ prompt }) => {
  return {
    messages: [prompt, `\`\`\`glsl
      precision mediump float;
      uniform float iTime;
      uniform vec2 iResolution;
      #define UV (gl_FragCoord.xy / iResolution);

      varying vec2 v_texCoord;

      `],
    system: "return a full, plain, glsl shader",
    stop: "```"
  }
})

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


export const shaderQuery = recipe(
  z.object({ focused: z.string(), prompt: z.string(), sourceCode: z.string(), triggerPrompt: z.string() }).describe("shader query"),
  ({ sourceCode, prompt, triggerPrompt, focused }) => {
    const { result: items, query } = schemaQuery(schema)

    const onCodeChange = handler<InputEvent, { sourceCode: string }>((e, state) => {
      state.sourceCode = (e.target as HTMLInputElement).value;
    });

    const onPromptChange = handler<InputEvent, { prompt: string }>((e, state) => {
      state.prompt = (e.target as HTMLInputElement).value;
    });

    const { result } = llm(buildGeneration({ prompt: triggerPrompt }))
    const hasResult = lift(({ result }) => !!result)({ result });

    return {
      [NAME]: 'Shader query',
      [UI]: <div style="width: 100%; height: 100%;">
        <div>
          <input type="string" value={prompt} placeholder="Prompt" oninput={onPromptChange({ prompt })}></input>
          <textarea value={grabGLSL({ result })} placeholder="Shader source" oninput={onCodeChange({ sourceCode })}></textarea>
          <button onclick={onGenerateShader({ prompt, triggerPrompt })}>Generate</button>
          <button onclick={onAddItem({ sourceCode: grabGLSL({ result }) })}>Add</button>
        </div>
        <div style="position: relative; width: 100%; height: 100%;">
          {items.map(({ sourceCode }) => {
            return <shader-layer width={640} height={480} shader={sourceCode}></shader-layer>
          })}
          {ifElse(hasResult, <shader-layer width={640} height={480} shader={grabGLSL({ result })}></shader-layer>, <div></div>)}
        </div>
      </div>,
      data: items,
      query
    };
  },
);
