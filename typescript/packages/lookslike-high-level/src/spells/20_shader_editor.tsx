import { h, Session, refer, $, select } from "@commontools/common-system";
import { event, subview, Transact } from "../sugar.js";
import { Charm, initRules, typedBehavior } from "./spell.jsx";
import { z } from "zod";
import { Reference } from "merkle-reference";
import { importEntity, resolve, tagWithSchema } from "../sugar/sugar.jsx";
import { Ref, UiFragment } from "../sugar/zod.js";
import { llm, RESPONSE } from "../effects/fetch.jsx";
import { log } from "../sugar/activity.js";

const adjectives = [
  "indigo",
  "azure",
  "crimson",
  "emerald",
  "golden",
  "silver",
  "obsidian",
  "sapphire",
];
const nouns = [
  "crossfire",
  "thunder",
  "storm",
  "blade",
  "phoenix",
  "dragon",
  "whisper",
  "shadow",
];

const CODE_REQUEST = "~/shader/modification-request";

function grabJs(result: string) {
  if (!result) {
    return;
  }
  const html = result.match(/```glsl\n([\s\S]+?)```/)?.[1];
  if (!html) {
    console.error("No GLSL found in text", result);
    return;
  }
  return html;
}

const generateIdentifier = () => {
  const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  return `${adjective}-${noun}`;
};

const SHADER_TEMPLATE = `    precision mediump float;
    uniform float iTime;
    uniform vec2 iResolution;
    #define UV (gl_FragCoord.xy / iResolution)

    varying vec2 v_texCoord;
`;

// Define the core schemas
export const Shader = z
  .object({
    name: z.string().min(1).max(255).describe("The name of the shader"),
    sourceCode: z
      .string()
      .min(1)
      .max(2 * 8192)
      .describe("The shader's GLSL source code"),
    notes: z.string().describe("Notes about the shader"),
  })
  .describe("Shader");

const ShaderEditor = z.object({
  editingShader: Ref.describe("The shader currently being edited"),
  shaders: z.array(Shader).describe("All shaders in the system"),
  "~/common/ui/shader-list": UiFragment.describe(
    "The UI fragment for the shaders list",
  ),
  "~/common/ui/navigation": UiFragment.describe(
    "The UI fragment for navigation",
  ),
});

const SourceModificationPrompt = z.object({
  prompt: z
    .string()
    .min(1)
    .max(8192)
    .describe("Prompt for modifying source code"),
  sourceId: Ref.describe("Reference to the shader to modify"),
});

type SubmitEvent<T> = {
  detail: { value: T };
};

type EditEvent = {
  detail: { item: Reference };
};

const shaderEditor = typedBehavior(Shader, {
  render: ({ self, name, sourceCode, notes }) => (
    <div entity={self}>
      <details>
        <summary>Edit</summary>
        <common-form
          schema={Shader}
          value={{ name, sourceCode: sourceCode || SHADER_TEMPLATE, notes }}
          onsubmit="~/on/save"
        />
        <h4>Modify with AI</h4>
        <common-form
          schema={SourceModificationPrompt}
          value={{ sourceId: self }}
          reset
          onsubmit="~/on/modify-with-ai"
        />
      </details>
      <div style="position: relative; width: 500px; height: 500px;">
        <shader-layer
          width={500}
          height={500}
          shader={sourceCode || SHADER_TEMPLATE}
        />
      </div>
      <details>
        <pre>{JSON.stringify({ name, sourceCode, notes }, null, 2)}</pre>
      </details>
    </div>
  ),
  rules: _ => ({
    onSave: event("~/on/save").transact(({ self, event }, cmd) => {
      const ev = Session.resolve<SubmitEvent<z.infer<typeof Shader>>>(event);
      const shader = ev.detail.value;
      cmd.add(...Transact.set(self, shader));
      cmd.add(...tagWithSchema(self, Shader));
      cmd.add(...log(self, "Edited shader"));
    }),

    onModifyWithAI: event("~/on/modify-with-ai")
      .with(resolve(Shader.pick({ sourceCode: true, notes: true })))
      .transact(({ self, event, sourceCode, notes }, cmd) => {
        const ev =
          Session.resolve<
            SubmitEvent<z.infer<typeof SourceModificationPrompt>>
          >(event);
        const message = `Modify the attached GLSL shader code based on the following prompt:
          <context>${notes}</context>
          <modification>${ev.detail.value.prompt}</modification>

          \`\`\`glsl\n${sourceCode || SHADER_TEMPLATE}\n\`\`\``;

        cmd.add(
          llm(self, CODE_REQUEST, {
            messages: [
              { role: "user", content: message },
              { role: "assistant", content: "```glsl\n" + SHADER_TEMPLATE },
            ],
            system: `You are a shader programming assistant. Modify the provided GLSL shader code according to the user's request.

          Return only the modified GLSL code wrapped in code blocks. Do not include any other text.`,
          }).json(),
        );
      }),

    onModificationComplete: select({
      self: $.self,
      request: $.request,
      payload: $.payload,
      content: $.content,
    })
      .match($.self, CODE_REQUEST, $.request)
      .match($.request, RESPONSE.JSON, $.payload)
      .match($.payload, "content", $.content)
      .transact(({ self, request, content, payload }, cmd) => {
        const code = grabJs(content);

        cmd.add({ Retract: [self, CODE_REQUEST, request] });
        cmd.add({ Retract: [request, RESPONSE.JSON, payload] });
        if (code) {
          cmd.add(...Transact.set(self, { sourceCode: code }));
        }
      }),
  }),
});

export const shaderManager = typedBehavior(
  ShaderEditor.pick({
    editingShader: true,
    shaders: true,
    "~/common/ui/shader-list": true,
    "~/common/ui/navigation": true,
  }),
  {
    render: ({
      self,
      editingShader,
      "~/common/ui/shader-list": shaderList,
      "~/common/ui/navigation": navigation,
    }) => (
      <div entity={self} title="Genuary">
        <div>
          <details>
            <h3>Create New Shader</h3>
            <common-form
              schema={Shader}
              value={{ sourceCode: SHADER_TEMPLATE }}
              reset
              onsubmit="~/on/add-shader"
            />
          </details>
        </div>

        {editingShader && (
          <div>
            <h3>Edit Shader</h3>
            <button onclick="~/on/close-shader-editor">Close</button>
            <Charm self={editingShader} spell={shaderEditor as any} />
            {subview(navigation)}
          </div>
        )}

        <div>
          <h3>Shaders</h3>
          {subview(shaderList)}
        </div>
      </div>
    ),
    rules: _ => ({
      init: initRules.init,

      onAddShader: event("~/on/add-shader").transact(({ self, event }, cmd) => {
        const ev = Session.resolve<SubmitEvent<z.infer<typeof Shader>>>(event);
        const shader = { ...ev.detail.value };

        const { self: id, instructions } = importEntity(shader, Shader);
        cmd.add(...instructions);
        cmd.add(...Transact.assert(self, { shaders: id }));
      }),

      onEditShader: event("~/on/edit-shader").transact(
        ({ self, event }, cmd) => {
          const ev = Session.resolve<EditEvent>(event);
          cmd.add(...Transact.set(self, { editingShader: ev.detail.item }));
        },
      ),

      onCloseShaderEditor: event("~/on/close-shader-editor")
        .with(resolve(ShaderEditor.pick({ editingShader: true })))
        .transact(({ self, editingShader }, cmd) => {
          cmd.add(...Transact.remove(self, { editingShader }));
        }),

      renderShaderList: resolve(ShaderEditor.pick({ shaders: true }))
        .update(({ self, shaders }) => {
          return [
            {
              Upsert: [
                self,
                "~/common/ui/shader-list",
                (
                  <common-table
                    schema={Shader}
                    data={shaders}
                    edit
                    delete
                    copy
                    onedit="~/on/edit-shader"
                    ondelete="~/on/delete-shader"
                  />
                ) as any,
              ],
            },
          ];
        })
        .commit(),

      renderNavigation: resolve(
        ShaderEditor.pick({ shaders: true, editingShader: true }),
      )
        .update(({ self, shaders, editingShader }) => {
          const currentIndex = shaders.findIndex(
            s => (s as any).self.toString() === editingShader?.toString(),
          );
          const shader = shaders[currentIndex];
          if (!shader) return [];

          return [
            {
              Upsert: [
                self,
                "~/common/ui/navigation",
                (
                  <div style="display: flex; align-items: center; gap: 1rem; margin: 1rem 0;">
                    <button
                      onclick={`~/on/prev-shader`}
                      disabled={currentIndex === 0}
                    >
                      Previous
                    </button>
                    <span>{shader.name}</span>
                    <button
                      onclick={`~/on/next-shader`}
                      disabled={currentIndex === shaders.length - 1}
                    >
                      Next
                    </button>
                  </div>
                ) as any,
              ],
            },
          ];
        })
        .commit(),

      onPrevShader: resolve(
        ShaderEditor.pick({ editingShader: true, shaders: true }),
      )
        .with(event("~/on/prev-shader"))
        .transact(({ self, shaders, editingShader }, cmd) => {
          const currentIndex = shaders.findIndex(
            s => (s as any).self.toString() === editingShader?.toString(),
          );
          if (currentIndex > 0) {
            cmd.add(
              ...Transact.set(self, {
                editingShader: (shaders[currentIndex - 1] as any).self,
              }),
            );
            cmd.add(...log(self, "Show prev shader"));
          }
        }),

      onNextShader: resolve(
        ShaderEditor.pick({ editingShader: true, shaders: true }),
      )
        .with(event("~/on/next-shader"))
        .transact(({ self, shaders, editingShader }, cmd) => {
          const currentIndex = shaders.findIndex(
            s => (s as any).self.toString() === editingShader?.toString(),
          );
          if (currentIndex < shaders.length - 1) {
            cmd.add(
              ...Transact.set(self, {
                editingShader: (shaders[currentIndex + 1] as any).self,
              }),
            );
            cmd.add(...log(self, "Show next shader"));
          }
        }),

      onDeleteShader: event("~/on/delete-shader").transact(
        ({ self, event }, cmd) => {
          const ev = Session.resolve<EditEvent>(event);
          cmd.add(...Transact.remove(self, { shaders: ev.detail.item }));
        },
      ),
    }),
  },
);

console.log(shaderManager);
