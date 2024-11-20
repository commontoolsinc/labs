import { h, behavior, $, Reference, select, service } from "@commontools/common-system";
import { build, make } from "../sugar/build.js";
import { event } from "../sugar/event.js";
import { Task, refer } from "synopsys";
import { tsToExports } from "../localBuild.js";
import { Session } from "@commontools/common-system";

export const source = { workbench: { v: 1 } };
const DEFAULT_SOURCE = `
import { h, behavior, $, select } from "@commontools/common-system";
import { build, make } from "../sugar/build.js";
import { query, queryDefault } from "../sugar/query.js";
import { event } from "../sugar/event.js";

const dispatch = (name: T) => \`~/on/\${name}\`;

export const spell = behavior({
  helloWorld: select({ self: $.self })
    .render(({ self }) => {
      return <div entity={self} title="Hello World">
        <h1>Hello World</h1>
        <p>This is a spell.</p>
        <button type="button" onclick={dispatch('click')}>Click me</button>
      </div>
    })
    .commit(),

  onClick: event('click')
    .update(({ self }) => {
      console.log('clicked', self)
      alert('Hello from ' + self.toString());
      return [];
    })
    .commit()
});
`

const createDispatch = <T extends string>(names: readonly T[]) => (name: T) => `~/on/${name}`;

// bf: probably not where we want to end up here but sort of works
// bf: there's something strange going on where new items look like clones of an existing item until you reload (I suspect local memory?)
const charms = (items: Reference[], behaviour: any) => items.map(a => <common-charm
  id={a.toString()}
  key={a.toString()}
  spell={() => behaviour}
  entity={() => a}
></common-charm>);

// bf: exploring typesafe event names
const dispatch = createDispatch(['new-spell', 'compile-spell', 'save-spell', 'rename-spell', 'code-change']);

const SpellModel = {
  name: '<unnamed spell>',
  sourceCode: '',
  'compiled': 'n/a',
}

function SpellView({ self, name, sourceCode, compiled }: { self: Reference, name: string, sourceCode: string, compiled: string }) {
  return <li title={name} entity={self}>
    <h2>{name}</h2>

    <h3>Source Code</h3>
    <pre>{sourceCode}</pre>

    <h3>Compiled Rules</h3>
    <pre>{compiled}</pre>
    <button onclick={dispatch('compile-spell')}>Compile</button>
  </li>
}

type State = any

const spellService = service({
  onNameChanged: {
    select: {
      self: $.self,
      event: $.event,
    },
    where: [
      { Case: [$.self, `~/on/rename-spell`, $.event] },
    ],
    *perform({ self, event }) {
      console.log(event, event.detail.value)

      return [
        { Upsert: [self, 'name', event.detail.value] }
      ];
    },
  },

  onCodeChanged: {
    select: {
      self: $.self,
      event: $.event,
    },
    where: [
      { Case: [$.self, `~/on/code-change`, $.event] },
    ],
    *perform({ self, event }) {
      console.log(event, Session.resolve(event).detail.state.doc.toString())

      return [
        { Upsert: [self, 'sourceCode', Session.resolve(event).detail.state.doc.toString()] }
      ];
    },
  },

  // bf: abusing a service to compile + render in the same rule
  // this seems fine and does render, but everything disappears when I trigger and event
  // and my handlers above aren't called
  render: {
    select: {
      self: $.self,
      sourceCode: $.sourceCode,
      name: $.name,
    },
    where: [
      { Case: [$.self, `sourceCode`, $.sourceCode] },
      { Case: [$.self, `name`, $.name] },
    ],
    *perform({ self, sourceCode, name }: { self: Reference; sourceCode: string; name: string; }) {
      const compiled = yield* Task.wait(tsToExports(sourceCode));
      console.log(compiled)

      const child = refer({ parent: self })

      return [
        {
          Upsert: [self, '~/common/ui', <div entity={self}>
            <common-input type="text" value={name} />
            <textarea>{sourceCode}</textarea>
            <button onclick={dispatch('save-spell')}>Save</button>
            <os-code-editor
              slot="content"
              language="text/x.jsx"
              source={sourceCode}
              ondoc-change={dispatch('code-change')}
            ></os-code-editor>
            <fieldset>
              <common-charm
                id={child}
                spell={() => compiled.exports.spell}
                entity={() => child}
              ></common-charm>
            </fieldset>
          </div>]
        }
      ];
    }
  }
})


export const spellWorkbench = behavior({
  spells: build('spells'),

  emptyStateView: select({ self: $.self })
    .not(q => q.match($.self, "spells", $.article))
    .render(({ self }) => {
      return <div entity={self} title="Workbench (empty)">
        <h1>Workbench</h1>
        <p>There are no articles in this collection.</p>
        <button onclick={dispatch('new-spell')}>New Spell</button>
      </div>
    })
    .commit(),

  listSpells: select({
    self: $.self,
    spells: [$.spell]
  })
    .match($.self, "spells", $.spell)
    .render(({ self, spells }) => {
      return <div entity={self} title="Workbench">
        <h1>Workbench</h1>
        {...charms(spells, spellService)}
        <pre>
          {JSON.stringify(spells, null, 2)}
        </pre>
        <button onclick={dispatch('new-spell')}>New Spell</button>
      </div>
    })
    .commit(),

  onAddItem: event('new-spell')
    .update(({ self, event }) => {
      return [
        make(self, { name: 'New Spell ' + Math.round(Math.random() * 1000), sourceCode: DEFAULT_SOURCE }),
      ]
    })
    .commit(),
})

console.log(spellWorkbench)

export const spawn = (input: {} = source) => spellWorkbench.spawn(input);
