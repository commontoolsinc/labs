import { h, behavior, $, select, refer } from "@commontools/common-system";
import { tamagotchi } from "./04_tamagotchi.jsx";

export const composed = behavior({
  defaultStates: select({ self: $.self })
    .not(q => q.match($.self, "importer", $._))
    .not(q => q.match($.self, "viewer", $._))
    .update(({ self }) => [
      { Assert: [self, "importer", refer({ importer: 1 })] },
      { Assert: [self, "viewer", refer({ viewer: 1 })] },
    ])
    .commit(),

  defaultView: select({ self: $.self, importer: $.importer, viewer: $.viewer })
    .match($.self, "importer", $.importer)
    .match($.self, "viewer", $.viewer)
    .render(({ self, importer, viewer }) => (
      <div entity={self} title="Composed" style="display: flex">
        <div style="flex: 1; width: 50%">
          <common-charm
            key={importer.toString()}
            id={importer.toString()}
            entity={() => importer}
            spell={() => tamagotchi}
          />
        </div>
        <div style="flex: 1; width: 50%">
          <common-charm
            key={viewer.toString()}
            id={viewer.toString()}
            entity={() => viewer}
            spell={() => tamagotchi}
          />
        </div>
      </div>
    ))
    .commit(),
});

export const spawn = (source: {} = { shared: 1 }) =>
  composed.spawn(source, "Composed");
