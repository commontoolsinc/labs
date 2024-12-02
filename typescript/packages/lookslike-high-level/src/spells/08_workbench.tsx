import {
  h,
  behavior,
  $,
  Reference,
  select,
  service,
} from "@commontools/common-system";
import { build, make, event, events, each } from "../sugar.js";
import { Task, refer } from "synopsys";
import { tsToExports } from "../localBuild.js";
import { Session } from "@commontools/common-system";
import { DocChangeEvent } from "../../../common-os-ui/lib/components/code-editor/os-code-editor.js";

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
`;

const WorkbenchEvents = events({
  onNewSpell: "~/on/new-spell",
  onCompileSpell: "~/on/compile-spell",
  onSaveSpell: "~/on/save-spell",
  onRenameSpell: "~/on/rename-spell",
  onCodeChange: "~/on/code-change",
});

const spellService = service({
  onNameChanged: {
    select: {
      self: $.self,
      event: $.event,
    },
    where: [{ Case: [$.self, WorkbenchEvents.onRenameSpell, $.event] }],
    *perform({ self, event }) {
      console.log(event, event.detail.value);

      return [{ Upsert: [self, "name", event.detail.value] }];
    },
  },

  onCodeChanged: {
    select: {
      self: $.self,
      event: $.event,
    },
    where: [{ Case: [$.self, WorkbenchEvents.onCodeChange, $.event] }],
    *perform({ self, event }) {
      const ev = Session.resolve<DocChangeEvent>(event)

      return [
        {
          Upsert: [
            self,
            "sourceCode",
            ev.detail.state.doc.toString(),
          ],
        },
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
    *perform({
      self,
      sourceCode,
      name,
    }: {
      self: Reference;
      sourceCode: string;
      name: string;
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
            <div entity={self}>
              <common-input type="text" value={name} />
              <textarea>{sourceCode}</textarea>
              <button onclick={WorkbenchEvents.onSaveSpell}>Save</button>
              <os-code-editor
                slot="content"
                language="text/x.jsx"
                source={sourceCode}
                ondoc-change={WorkbenchEvents.onCodeChange}
              ></os-code-editor>
              <fieldset>
                <common-charm
                  id={child.toString()}
                  key={child.toString()}
                  spell={() => compiled.exports.spell}
                  entity={() => child}
                ></common-charm>
              </fieldset>
            </div> as any,
          ],
        },
      ];
    },
  },
});

export const spellWorkbench = behavior({
  spells: build("spells"),

  emptyStateView: select({ self: $.self })
    .not(q => q.match($.self, "spells", $.article))
    .render(({ self }) => {
      return (
        <div entity={self} title="Workbench (empty)">
          <h1>Workbench</h1>
          <p>There are no articles in this collection.</p>
          <button onclick={WorkbenchEvents.onNewSpell}>New Spell</button>
        </div>
      );
    })
    .commit(),

  listSpells: select({
    self: $.self,
    spells: [$.spell],
  })
    .match($.self, "spells", $.spell)
    .render(({ self, spells }) => {
      return (
        <div entity={self} title="Workbench">
          <h1>Workbench</h1>
          {each(spells, spellService)}
          <pre>{JSON.stringify(spells, null, 2)}</pre>
          <button onclick={WorkbenchEvents.onNewSpell}>New Spell</button>
        </div>
      );
    })
    .commit(),

  onAddItem: event(WorkbenchEvents.onNewSpell)
    .update(({ self, event }) => {
      return [
        make(self, {
          name: "New Spell " + Math.round(Math.random() * 1000),
          sourceCode: DEFAULT_SOURCE,
        }),
      ];
    })
    .commit(),
});

export const spawn = (input: {} = source) =>
  spellWorkbench.spawn(input, "Workbench");
