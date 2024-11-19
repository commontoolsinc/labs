import { h, behavior, $, Reference, select, Select, service } from "@commontools/common-system";
import { Variable } from 'datalogia'
import { build, make } from "../sugar/build.js";
import { query, queryDefault } from "../sugar/query.js";
import { event } from "../sugar/event.js";
import { fetch, llm } from "../effects/fetch.js";
import { Constant, Instruction, refer, Task } from "synopsys";
import { tsToExports } from "../localBuild.js";

export const source = { workbench: { v: 1 } };
const DEFAULT_SOURCE = `
import { h, behavior, $, select } from "@commontools/common-system";

export const spell = behavior({
  helloWorld: select({ self: $.self })
    .render(({ self }) => {
      return <div entity={self} title="Hello World">
        <h1>Hello World</h1>
        <p>This is a spell.</p>
      </div>
    })
    .commit()
});
`

const createDispatch = <T extends string>(names: readonly T[]) => (name: T) => `~/on/${name}`;

// bf: probably not where we want to end up here but sort of works
// bf: there's something strange going on where new items look like clones of an existing item until you reload (I suspect local memory?)
const charms = (items: Reference[], behaviour: any) => items.map(a => <common-charm
  id={a.toString()}
  spell={() => behaviour}
  entity={() => a}
></common-charm>);

function upsert(self: Reference, fields: {}): Instruction[] {
  return Object.entries(fields).map(([k, v]) => ({ Upsert: [self, k, v] } as Instruction));
}

function retract(self: Reference, fields: {}): Instruction[] {
  return Object.entries(fields).map(([k, v]) => ({ Retract: [self, k, v] } as Instruction));
}

// bf: exploring typesafe event names
const dispatch = createDispatch(['new-spell', 'compile-spell']);

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

const compiledSpells = new Map<String, State>();

const spellView = behavior({
  view: queryDefault(SpellModel, 'name', 'sourceCode', 'compiled')
    .render(SpellView)
    .commit(),
});

const spellService = service({
  // onCompileSpell: {
  //   select: {
  //     self: $.self,
  //     sourceCode: $.sourceCode,
  //     event: $.event,
  //   },
  //   where: [
  //     { Case: [$.self, `sourceCode`, $.sourceCode] },
  //     { Case: [$.self, `~/on/compile-spell`, $.event] },
  //   ],
  //   *perform({ self, sourceCode }: { self: Reference; sourceCode: string }) {
  //     const compiled = yield* Task.wait(tsToExports(sourceCode));
  //     const exports = JSON.stringify(compiled, null, 2);
  //     const hash = refer({ sourceCode })

  //     console.log(compiled, exports)
  //     compiledSpells.set(hash.toString(), compiled)

  //     return [
  //       { Upsert: [self, 'compiled', exports] }
  //     ];
  //   },
  // },

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
      const exports = JSON.stringify(compiled, null, 2);
      const hash = refer({ sourceCode })

      console.log(compiled, exports)
      compiledSpells.set(hash.toString(), compiled)

      return [
        {
          Upsert: [self, '~/common/ui', <div entity={self}>
            <common-input type="text" value={name} />
            <textarea>{sourceCode}</textarea>
            {/* <button onclick={dispatch('save-spell')}>Save</button> */}
            <os-code-editor
              slot="content"
              language="text/x.jsx"
              source={sourceCode}
            ></os-code-editor>
            <fieldset>
              <common-charm
                id={self.toString() + '/sandbox'}
                spell={() => compiled.exports.spell}
                entity={() => self}
              ></common-charm>
            </fieldset>
          </div>]
        }
      ];
    }
  }

  // onCompileSpell:
  //   query(SpellModel, 'sourceCode')
  //     .event('compile-spell')
  //     .update(({ self, event, sourceCode }) => {
  //       const x = tsToExports(sourceCode);

  //       return [
  //         ...upsert(self, { compiled: true }),
  //       ]
  //     })
  //     .commit(),
})


export const spellWorkbench = behavior({
  spells: build('spells'),

  // empty state view
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

  listArticlesView: select({
    self: $.self,
    spells: [$.spell]
  })
    .match($.self, "spells", $.spell)
    .render(({ self, spells }) => {
      return <div entity={self} title="Workbench">
        <h1>Workbench</h1>
        {/* {...charms(spells, spellView)} */}
        {...charms(spells, spellService)}
        <pre>
          {JSON.stringify(spells, null, 2)}
        </pre>
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
