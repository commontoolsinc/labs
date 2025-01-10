import { h, Session, refer, $, Task, select } from "@commontools/common-system";
import { event, subview, Transact } from "../sugar.js";
import {
  Charm as CharmComponent,
  initRules,
  typedBehavior,
  typedService,
} from "./spell.jsx";
import { z } from "zod";
import { Reference } from "merkle-reference";
import { importEntity, list, resolve, tagWithSchema } from "../sugar/sugar.jsx";
import { Ref, UiFragment } from "../sugar/zod.js";
import { tsToExports } from "../localBuild.js";
import { llm, RESPONSE } from "../effects/fetch.jsx";
import { log } from "../sugar/activity.js";
import { spellPrompt } from "./spellPrompt.js";

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

const CODE_REQUEST = "~/spell/modification-request";

function grabJs(result: string) {
  if (!result) {
    return;
  }
  const html = result.match(/```js\n([\s\S]+?)```/)?.[1];
  if (!html) {
    console.error("No JS found in text", result);
    return;
  }
  return html;
}

const generateIdentifier = () => {
  const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  return `${adjective}-${noun}`;
};

// Define the core schemas
export const Spell = z
  .object({
    name: z.string().min(1).max(255).describe("The name of the spell"),
    sourceCode: z.string().min(1).max(8192).describe("The spell's source code"),
    notes: z.string().describe("Notes about the spell"),
    instances: z
      .array(Ref)
      .describe("References to charm instances of this spell"),
  })
  .describe("Spell");

export const Charm = z
  .object({
    spell: Ref.describe("Reference to the spell this charm instantiates"),
    name: z.string().min(1).max(255).describe("The name of the charm"),
  })
  .describe("Charm");

const CharmInstance = z.object({ charm: Ref });

const SpellManager = z.object({
  editingSpell: Ref.describe("The spell currently being edited"),
  focusedCharm: Ref.describe("The charm that is currently being viewed"),
  spells: z
    .array(Spell.omit({ instances: true }))
    .describe("All spells in the system"),
  charms: z.array(Charm).describe("All charm instances"),
  "~/common/ui/spell-list": UiFragment.describe(
    "The UI fragment for the spells list",
  ),
  "~/common/ui/charm-list": UiFragment.describe(
    "The UI fragment for the charms list",
  ),
  "~/common/ui/charm-picker": UiFragment.describe("find Charms to display"),
  "~/common/ui/spell-picker": UiFragment.describe("find Spells to display"),
});

const SourceModificationPrompt = z.object({
  prompt: z
    .string()
    .min(1)
    .max(1000)
    .describe("Prompt for modifying source code"),
  sourceId: Ref.describe("Reference to the spell to modify"),
});

type SubmitEvent<T> = {
  detail: { value: T };
};

type FocusEvent = {
  detail: { charmId: Reference };
};

type EditEvent = {
  detail: { item: Reference };
};

const CharmWithSpell = z.object({
  spell: Spell.omit({ instances: true }).describe(
    "Reference to the spell this charm instantiates",
  ),
});

export const charmViewer = typedService(CharmWithSpell, {
  rules: _ => ({
    renderCharm: {
      select: {
        self: $.self,
        spell: {
          self: $.spell,
          name: $.name,
          sourceCode: $.sourceCode,
        },
      },
      where: [
        { Case: [$.self, "spell", $.spell] },
        { Case: [$.spell, `sourceCode`, $.sourceCode] },
        { Case: [$.spell, `name`, $.name] },
      ],
      *perform({
        self,
        spell: { name, sourceCode },
      }: {
        self: Reference;
        spell: { name: string; sourceCode: string };
      }) {
        const compiled = yield* Task.wait(tsToExports(sourceCode));
        console.log(compiled);

        const child = refer({
          parent: self,
          compiled: compiled.exports.spell.id,
          time: Date.now(),
        });

        return [
          {
            Upsert: [
              self,
              "~/common/ui",
              (
                <div entity={self}>
                  <common-charm
                    id={child.toString()}
                    key={child.toString()}
                    spell={() => compiled.exports.spell}
                    entity={() => child}
                  ></common-charm>
                </div>
              ) as any,
            ],
          },
        ];
      },
    },
  }),
});

const logEntries = select({
  self: $.self,
  log: [{ self: $.log, message: $.message, modified: $.modified }],
})
  .match($.self, "common/activity", $.log)
  .match($.log, "message", $.message)
  .match($.log, "modified", $.modified);

const spellEditor = typedBehavior(Spell, {
  render: ({ self, name, sourceCode, notes }) => (
    <div entity={self}>
      <common-form
        schema={Spell.omit({ instances: true })}
        value={{ name, sourceCode, notes }}
        onsubmit="~/on/save"
      />
      <h4>Modify with AI</h4>
      <common-form
        schema={SourceModificationPrompt}
        value={{ sourceId: self }}
        reset
        onsubmit="~/on/modify-with-ai"
      />
      <details>
        <pre>{JSON.stringify({ name, sourceCode, notes }, null, 2)}</pre>
      </details>
    </div>
  ),
  rules: _ => ({
    onSave: event("~/on/save").transact(({ self, event }, cmd) => {
      const ev = Session.resolve<SubmitEvent<z.infer<typeof Spell>>>(event);
      const spell = ev.detail.value;
      cmd.add(...Transact.set(self, spell));
      cmd.add(...tagWithSchema(self, Spell));
    }),

    // listLogEntries: select({
    //   self: $.self,
    //   log: [{ self: $.log, message: $.message, modified: $.modified }],
    // })
    //   .match($.self, "common/activity", $.log)
    //   .match($.log, "message", $.message)
    //   .match($.log, "modified", $.modified)
    //   .transact(({ self, log }, cmd) => {
    //     debugger;
    //   }),

    onModifyWithAI: event("~/on/modify-with-ai")
      .with(resolve(Spell.pick({ sourceCode: true, notes: true })))
      .with(logEntries)
      .transact(({ self, event, sourceCode, notes, log: logEntries }, cmd) => {
        const ev =
          Session.resolve<
            SubmitEvent<z.infer<typeof SourceModificationPrompt>>
          >(event);

        cmd.add(...log(self, "AI modification: " + ev.detail.value.prompt));

        const message = `Modify the attached source code based on the following prompt:
          <context>${notes}</context>
          <change-history>${JSON.stringify(logEntries)}</change-history>
          <modification>${ev.detail.value.prompt}</modification>

          \`\`\`js\n${sourceCode}\n\`\`\``;

        cmd.add(
          llm(self, CODE_REQUEST, {
            messages: [
              { role: "user", content: message },
              { role: "assistant", content: "```js\n" },
            ],
            system: spellPrompt,
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

type PickEvent = {
  detail: { value: Reference; label: string };
};

export const spellManager = typedBehavior(
  SpellManager.pick({
    editingSpell: true,
    focusedCharm: true,
    "~/common/ui/spell-list": true,
    "~/common/ui/charm-list": true,
    "~/common/ui/charm-picker": true,
    "~/common/ui/spell-picker": true,
  }),
  {
    render: ({
      self,
      editingSpell,
      focusedCharm,
      "~/common/ui/spell-list": spellList,
      "~/common/ui/charm-list": charmList,
      "~/common/ui/charm-picker": charmPicker,
      "~/common/ui/spell-picker": spellPicker,
    }) => {
      const containerStyle = `
        display: flex;
        height: 100vh;
        background: #ffffff;
        color: #1d1d1f;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", sans-serif;
      `;

      const sidebarStyle = `
        width: 33%;
        min-width: 320px;
        background: #f5f5f7;
        border-right: 1px solid #e5e5e5;
        padding: 12px;
        overflow-y: auto;
      `;

      const mainStyle = `
        flex: 1;
        padding: 12px;
        overflow-y: auto;
        background: #ffffff;
      `;

      const detailsStyle = `
        background: #ffffff;
        border-radius: 8px;
        margin-bottom: 12px;
        border: 1px solid #e5e5e5;
      `;

      const summaryStyle = `
        padding: 8px 12px;
        font-weight: 500;
        cursor: pointer;
        background: #ffffff;
        border-bottom: 1px solid #e5e5e5;
        user-select: none;
        color: #1d1d1f;
        display: flex;
        justify-content: space-between;
        align-items: center;
        &:hover {
          background: #f5f5f7;
        }
      `;

      const formContainerStyle = `
        padding: 12px;
      `;

      const headingStyle = `
        font-size: 24px;
        font-weight: 600;
        margin: 0 0 16px 0;
        padding-bottom: 8px;
        border-bottom: 1px solid #e5e5e5;
        color: #1d1d1f;
      `;

      const buttonStyle = `
        background: #0071e3;
        border: none;
        color: #ffffff;
        padding: 6px 12px;
        border-radius: 6px;
        cursor: pointer;
        font-weight: 500;
        transition: background-color 0.2s ease;
        &:hover {
          background: #0077ED;
        }
      `;

      const closeButtonStyle = `
        ${buttonStyle}
        margin-left: 8px;
      `;

      return (
        <div entity={self} title="Spell Manager" style={containerStyle}>
          <div style={sidebarStyle}>
            <h2 style={headingStyle}>Spell Manager</h2>

            <details style={detailsStyle}>
              <summary style={summaryStyle}>Create New Spell</summary>
              <div style={formContainerStyle}>
                <common-form
                  schema={Spell.omit({ instances: true })}
                  reset
                  onsubmit="~/on/add-spell"
                />
              </div>
            </details>

            <details style={detailsStyle}>
              <summary style={summaryStyle}>Instantiate Charm</summary>
              <div style={formContainerStyle}>{subview(spellPicker)}</div>
            </details>

            <details style={detailsStyle}>
              <summary style={summaryStyle}>Focus Charm</summary>
              <div style={formContainerStyle}>{subview(charmPicker)}</div>
            </details>

            <details style={detailsStyle} open>
              <summary style={summaryStyle}>Spells</summary>
              <div style={formContainerStyle}>{subview(spellList)}</div>
            </details>

            <details style={detailsStyle} open>
              <summary style={summaryStyle}>Charms</summary>
              <div style={formContainerStyle}>{subview(charmList)}</div>
            </details>
          </div>

          <div style={mainStyle}>
            {focusedCharm ? (
              <div>
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
                  <h2 style={headingStyle}>
                    Focused Charm
                    <button
                      style={closeButtonStyle}
                      onclick="~/on/unfocus-charm"
                    >
                      Close
                    </button>
                  </h2>
                </div>
                <CharmComponent
                  self={focusedCharm}
                  spell={charmViewer as any}
                />
              </div>
            ) : (
              <div style="display: flex; align-items: center; justify-content: center; height: 33%; color: #666;">
                <h2>Select a charm to focus</h2>
              </div>
            )}
            {editingSpell ? (
              <details style={detailsStyle} open>
                <summary style={summaryStyle}>
                  <span>Edit Spell</span>
                  <button style={buttonStyle} onclick="~/on/close-spell-editor">
                    Close
                  </button>
                </summary>
                <div style={formContainerStyle}>
                  <CharmComponent
                    self={editingSpell}
                    spell={spellEditor as any}
                  />
                </div>
              </details>
            ) : (
              <div></div>
            )}
          </div>
        </div>
      );
    },
    rules: _ => ({
      init: initRules.init,

      onAddSpell: event("~/on/add-spell").transact(({ self, event }, cmd) => {
        const ev = Session.resolve<SubmitEvent<z.infer<typeof Spell>>>(event);
        const spell = { ...ev.detail.value };

        const { self: id, instructions } = importEntity(spell, Spell);
        cmd.add(...instructions);
        cmd.add(...Transact.assert(self, { spells: id }));
      }),

      onCreateCharm: event("~/on/create-charm").transact(
        ({ self, event }, cmd) => {
          const ev = Session.resolve<SubmitEvent<z.infer<typeof Charm>>>(event);
          const charm = ev.detail.value as { spell: Reference };
          (charm as any).name = generateIdentifier();

          const { self: charmId, instructions } = importEntity(charm, Charm);
          cmd.add(...instructions);
          cmd.add(...Transact.assert(self, { charms: charmId }));
          cmd.add(...log(self, "Created charm " + (charm as any).name));

          if (charm.spell) {
            cmd.add(...Transact.assert(charm.spell, { instances: charmId }));
          }
        },
      ),

      renderCharmPicker: list(Charm, Charm.pick({ name: true }))
        .update(({ items, self }) => {
          return [
            {
              Upsert: [
                self,
                "~/common/ui/charm-picker",
                (
                  <div>
                    <common-picker
                      items={items.map(item => ({
                        value: item.self,
                        label: item.name + " (" + item.self.toString() + ")",
                      }))}
                      onpick="~/on/pick-charm"
                    />
                  </div>
                ) as any,
              ],
            },
          ];
        })
        .commit(),

      renderSpellPicker: list(Spell, Spell.pick({ name: true }))
        .update(({ items, self }) => {
          return [
            {
              Upsert: [
                self,
                "~/common/ui/spell-picker",
                (
                  <div>
                    <common-picker
                      items={items.map(item => ({
                        value: item.self,
                        label: item.name + " (" + item.self.toString() + ")",
                      }))}
                      onpick="~/on/pick-spell"
                    />
                  </div>
                ) as any,
              ],
            },
          ];
        })
        .commit(),

      onPickSpell: event("~/on/pick-spell").transact(({ self, event }, cmd) => {
        const ev = Session.resolve<PickEvent>(event);
        const charm = { spell: ev.detail.value };
        (charm as any).name = generateIdentifier();

        const { self: charmId, instructions } = importEntity(charm, Charm);
        cmd.add(...instructions);
        cmd.add(...Transact.assert(self, { charms: charmId }));
        cmd.add(...log(self, "Created charm " + (charm as any).name));

        if (charm.spell) {
          cmd.add(...Transact.assert(charm.spell, { instances: charmId }));
        }
      }),

      onPickCharm: event("~/on/pick-charm").transact(({ self, event }, cmd) => {
        const ev = Session.resolve<PickEvent>(event);
        const charm = ev.detail.value;

        if (charm) {
          cmd.add(...Transact.set(self, { focusedCharm: charm }));
        }
      }),

      onFocusCharm: event("~/on/focus-charm").transact(
        ({ self, event }, cmd) => {
          const ev =
            Session.resolve<SubmitEvent<z.infer<typeof CharmInstance>>>(event);
          if (ev.detail.value.charm) {
            const charm = ev.detail.value.charm;
            cmd.add(...Transact.set(self, { focusedCharm: charm }));
          }
        },
      ),

      onEditSpell: event("~/on/edit-spell").transact(({ self, event }, cmd) => {
        const ev = Session.resolve<EditEvent>(event);
        cmd.add(...Transact.set(self, { editingSpell: ev.detail.item }));
      }),

      onCloseSpellEditor: event("~/on/close-spell-editor")
        .with(resolve(SpellManager.pick({ editingSpell: true })))
        .transact(({ self, editingSpell }, cmd) => {
          cmd.add(...Transact.remove(self, { editingSpell }));
        }),

      onUnfocusCharm: event("~/on/unfocus-charm")
        .with(resolve(SpellManager.pick({ focusedCharm: true })))
        .transact(({ self, focusedCharm }, cmd) => {
          cmd.add(...Transact.remove(self, { focusedCharm }));
        }),

      renderSpellList: resolve(SpellManager.pick({ spells: true }))
        .update(({ self, spells }) => {
          return [
            {
              Upsert: [
                self,
                "~/common/ui/spell-list",
                (
                  <common-table
                    schema={Spell}
                    data={spells}
                    edit
                    delete
                    download
                    copy
                    onedit="~/on/edit-spell"
                    ondelete="~/on/delete-spell"
                  />
                ) as any,
              ],
            },
          ];
        })
        .commit(),

      renderCharmList: resolve(SpellManager.pick({ charms: true }))
        .update(({ self, charms }) => {
          return [
            {
              Upsert: [
                self,
                "~/common/ui/charm-list",
                (
                  <common-table
                    schema={Charm}
                    data={charms}
                    copy
                    delete
                    ondelete="~/on/delete-charm"
                  />
                ) as any,
              ],
            },
          ];
        })
        .commit(),

      onDeleteSpell: event("~/on/delete-spell").transact(
        ({ self, event }, cmd) => {
          const ev = Session.resolve<EditEvent>(event);
          cmd.add(...Transact.remove(self, { spells: ev.detail.item }));
        },
      ),

      onDeleteCharm: event("~/on/delete-charm").transact(
        ({ self, event }, cmd) => {
          const ev = Session.resolve<EditEvent>(event);
          cmd.add(...Transact.remove(self, { charms: ev.detail.item }));
        },
      ),
    }),
  },
);

console.log(spellManager);
