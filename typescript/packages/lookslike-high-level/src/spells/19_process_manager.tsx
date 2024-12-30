import {
  h,
  Session,
  refer,
  $,
  Task,
} from "@commontools/common-system";
import { event, subview, Transact } from "../sugar.js";
import { Charm as CharmComponent, initRules, typedBehavior, typedService } from "./spell.jsx";
import { z } from "zod";
import { fromString, Reference } from "merkle-reference";
import { importEntity, resolve } from "../sugar/sugar.jsx";
import { Ref, UiFragment } from "../sugar/zod.js";
import { tsToExports } from "../localBuild.js";

const adjectives = ['indigo', 'azure', 'crimson', 'emerald', 'golden', 'silver', 'obsidian', 'sapphire'];
const nouns = ['crossfire', 'thunder', 'storm', 'blade', 'phoenix', 'dragon', 'whisper', 'shadow'];

const generateIdentifier = () => {
  const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  return `${adjective}-${noun}`;
};

// Define the core schemas
const Spell = z.object({
  name: z.string().min(1).max(255).describe("The name of the spell"),
  sourceCode: z.string().min(1).max(8192).describe("The spell's source code"),
  notes: z.string().describe("Notes about the spell"),
  instances: z.array(Ref).describe("References to charm instances of this spell")
});

const Charm = z.object({
  spell: Ref.describe("Reference to the spell this charm instantiates"),
  name: z.string().min(1).max(255).describe("The name of the charm"),
});

const CharmInstance = z.object({ charm: Ref })

const SpellManager = z.object({
  editingSpell: Ref.describe("The spell currently being edited"),
  focusedCharm: Ref.describe("The charm that is currently being viewed"),
  spells: z.array(Spell.omit({ instances: true })).describe("All spells in the system"),
  charms: z.array(Charm).describe("All charm instances"),
  '~/common/ui/spell-list': UiFragment.describe("The UI fragment for the spells list"),
  '~/common/ui/charm-list': UiFragment.describe("The UI fragment for the charms list")
});

type SubmitEvent<T> = {
  detail: { value: T }
};

type FocusEvent = {
  detail: { charmId: Reference }
};

type EditEvent = {
  detail: { item: Reference }
};

const CharmWithSpell = z.object({
  spell: Spell.omit({ instances: true }).describe("Reference to the spell this charm instantiates")
});

export const charmViewer = typedService(CharmWithSpell, {
  rules: _ => ({
    renderCharm: {
      select: {
        self: $.self,
        spell: {
          self: $.spell,
          name: $.name,
          sourceCode: $.sourceCode
        }
      },
      where: [
        { Case: [$.self, 'spell', $.spell] },
        { Case: [$.spell, `sourceCode`, $.sourceCode] },
        { Case: [$.spell, `name`, $.name] },
      ],
      *perform({
        self,
        spell: { name, sourceCode }
      }: {
        self: Reference;
        spell: { name: string; sourceCode: string };
      }) {
        debugger
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
              <div entity={self}>
                <common-charm
                  id={child.toString()}
                  key={child.toString()}
                  spell={() => compiled.exports.spell}
                  entity={() => child}
                ></common-charm>
              </div> as any,
            ],
          },
        ];
      },
    }
  })
});

const spellEditor = typedBehavior(Spell, {
  render: ({ self, name, sourceCode, notes }) => (
    <div entity={self}>
      <common-form
        schema={Spell.omit({ instances: true })}
        value={{ name, sourceCode, notes }}
        onsubmit="~/on/save"
      />
      <details>
        <pre>{JSON.stringify({ name, sourceCode, notes }, null, 2)}</pre>
      </details>
    </div>
  ),
  rules: _ => ({
    onSave: event("~/on/save")
      .transact(({ self, event }, cmd) => {
        const ev = Session.resolve<SubmitEvent<z.infer<typeof Spell>>>(event);
        const spell = ev.detail.value;
        cmd.add(...Transact.set(self, spell))
      }),
  })
});

export const spellManager = typedBehavior(
  SpellManager.pick({
    editingSpell: true,
    focusedCharm: true,
    '~/common/ui/spell-list': true,
    '~/common/ui/charm-list': true
  }), {
  render: ({ self, editingSpell, focusedCharm, '~/common/ui/spell-list': spellList, '~/common/ui/charm-list': charmList }) => (
    <div entity={self}>
      <div>
        <details>
          <h3>Create New Spell</h3>
          <common-form
            schema={Spell.omit({ instances: true })}
            reset
            onsubmit="~/on/add-spell"
          />

          <h3>Instantiate Charm</h3>
          <common-form
            schema={Charm.omit({ name: true })}
            referenceFields={new Set(['spell'])}
            reset
            onsubmit="~/on/create-charm"
          />

          <h3>Focus Charm</h3>
          <common-form
            schema={CharmInstance}
            referenceFields={new Set(['charm'])}
            reset
            onsubmit="~/on/focus-charm"
          />
        </details>
      </div>

      {editingSpell && (
        <div>
          <h3>Edit Spell</h3>
          <button onclick="~/on/close-spell-editor">Close</button>
          <CharmComponent self={editingSpell} spell={spellEditor as any} />
        </div>
      )}

      {focusedCharm && (
        <div>
          <h3>Focused Charm</h3>
          <button onclick="~/on/unfocus-charm">Close</button>
          <CharmComponent self={focusedCharm} spell={charmViewer as any} />
        </div>
      )}

      <div>
        <h3>Spells</h3>
        {subview(spellList)}
        <h3>Charms</h3>
        {subview(charmList)}
      </div>
    </div>
  ),
  rules: _ => ({
    init: initRules.init,

    onAddSpell: event("~/on/add-spell")
      .transact(({ self, event }, cmd) => {
        const ev = Session.resolve<SubmitEvent<z.infer<typeof Spell>>>(event);
        const spell = { ...ev.detail.value };

        const { self: id, instructions } = importEntity(spell, Spell)
        cmd.add(...instructions);
        cmd.add(...Transact.assert(self, { spells: id }));
      }),

    onCreateCharm: event("~/on/create-charm")
      .transact(({ self, event }, cmd) => {
        const ev = Session.resolve<SubmitEvent<z.infer<typeof Charm>>>(event);
        const charm = ev.detail.value as { spell: Reference };
        (charm as any).name = generateIdentifier();

        const { self: charmId, instructions } = importEntity(charm, Charm);
        cmd.add(...instructions);
        cmd.add(...Transact.assert(self, { charms: charmId }));

        if (charm.spell) {
          cmd.add(...Transact.assert(charm.spell, { instances: charmId }));
        }
      }),

    onFocusCharm: event("~/on/focus-charm")
      .transact(({ self, event }, cmd) => {
        const ev = Session.resolve<SubmitEvent<z.infer<typeof CharmInstance>>>(event);
        if (ev.detail.value.charm) {
          const charm = (ev.detail.value.charm)
          cmd.add(...Transact.set(self, { focusedCharm: charm }));
        }
      }),

    onEditSpell: event("~/on/edit-spell")
      .transact(({ self, event }, cmd) => {
        const ev = Session.resolve<EditEvent>(event);
        cmd.add(...Transact.set(self, { editingSpell: ev.detail.item }))
      }),

    onCloseSpellEditor: event("~/on/close-spell-editor")
      .with(resolve(SpellManager.pick({ editingSpell: true })))
      .transact(({ self, editingSpell }, cmd) => {
        cmd.add(...Transact.remove(self, { editingSpell }))
      }),

    onUnfocusCharm: event("~/on/unfocus-charm")
      .with(resolve(SpellManager.pick({ focusedCharm: true })))
      .transact(({ self, focusedCharm }, cmd) => {
        cmd.add(...Transact.remove(self, { focusedCharm }))
      }),

    renderSpellList: resolve(SpellManager.pick({ spells: true }))
      .update(({ self, spells }) => {
        return [{
          Upsert: [self, '~/common/ui/spell-list', <common-table
            schema={Spell}
            data={spells}
            onedit="~/on/edit-spell"
            ondelete="~/on/delete-spell"
          /> as any]
        }]
      }).commit(),

    renderCharmList: resolve(SpellManager.pick({ charms: true }))
      .update(({ self, charms }) => {
        return [{
          Upsert: [self, '~/common/ui/charm-list', <common-table
            schema={Charm}
            data={charms}
            ondelete="~/on/delete-charm"
          /> as any]
        }]
      }).commit(),

    onDeleteSpell: event("~/on/delete-spell")
      .transact(({ self, event }, cmd) => {
        const ev = Session.resolve<EditEvent>(event);
        cmd.add(...Transact.remove(self, { spells: ev.detail.item }))
      }),

    onDeleteCharm: event("~/on/delete-charm")
      .transact(({ self, event }, cmd) => {
        const ev = Session.resolve<EditEvent>(event);
        cmd.add(...Transact.remove(self, { charms: ev.detail.item }))
      }),
  }),
});

console.log(spellManager);
