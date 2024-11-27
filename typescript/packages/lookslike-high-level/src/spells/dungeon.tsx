import { h, behavior, $, Reference, select, View } from "@commontools/common-system";
import { analyzeRuleDependencies } from "../viz.js";

export const source = { dungeon: { v: 1 } };

export const rules = behavior({
  initPlayer: select({ self: $.self })
    .not.match($.self, "player/x", $._)
    .not.match($.self, "player/y", $._)
    .assert(({ self }) => [self, "player/x", 1])
    .assert(({ self }) => [self, "player/y", 1])
    .commit(),

  initSkeleton: select({ self: $.self })
    .not.match($.self, "skeleton/x", $._)
    .not.match($.self, "skeleton/y", $._)
    .assert(({ self }) => [self, "skeleton/x", 4])
    .assert(({ self }) => [self, "skeleton/y", 6])
    .commit(),

  skeletonMove: select({
    self: $.self,
    px: $['player/x'],
    py: $['player/y'],
    sx: $['skeleton/x'],
    sy: $['skeleton/y']
  })
    .match($.self, "player/x", $['player/x'])
    .match($.self, "player/y", $['player/y'])
    .match($.self, "skeleton/x", $['skeleton/x'])
    .match($.self, "skeleton/y", $['skeleton/y'])
    .upsert((result) => {
      // Move skeleton towards player
      if (Math.random() < 0.2) {
        const dx = result.px > result.sx ? 1 : result.px < result.sx ? -1 : 0;
        return [result.self, 'skeleton/x', result.sx + dx];
      } else {
        return [result.self, 'skeleton/x', result.sx];
      }
    })
    .upsert((result) => {
      if (Math.random() < 0.2) {
        const dy = result.py > result.sy ? 1 : result.py < result.sy ? -1 : 0;
        return [result.self, 'skeleton/y', result.sy + dy];
      } else {
        return [result.self, 'skeleton/y', result.sy];
      }
    })
    .commit(),

  status: select({ self: $.self, px: $['player/x'], py: $['player/y'], sx: $['skeleton/x'], sy: $['skeleton/y'] })
    .match($.self, "player/x", $['player/x'])
    .match($.self, "player/y", $['player/y'])
    .match($.self, "skeleton/x", $['skeleton/x'])
    .match($.self, "skeleton/y", $['skeleton/y'])
    .render((result) => {
      const grid = Array.from({ length: 16 }).map(() => Array.from({ length: 16 }).fill(0));

      return (
        <div title={`Dungeon`} entity={result.self} style="padding: 32px">
          <div>Player: {result.px}, {result.py}</div>
          <div>Skeleton: {result.sx}, {result.sy}</div>
          <div>
            <button onclick="~/on/up">UP</button>
            <button onclick="~/on/down">DOWN</button>
            <button onclick="~/on/left">LEFT</button>
            <button onclick="~/on/right">RIGHT</button>
          </div>
          <table style="border: 1px solid black; border-collapse: collapse">
            {...grid.map((row, i) => (
              <tr>
                {...row.map((cell, j) => (
                  <td style="border: 1px solid black; width: 20px; height: 20px; text-align: center">
                    {i == result.py - 1 && j == result.px - 1 ? 'P' : i == result.sy - 1 && j == result.sx - 1 ? 'S' : ''}
                  </td>
                ))}
              </tr>
            ))}
          </table>
          <div>
            <button onclick="~/on/reset">RESET</button>
          </div>
        </div>
      );
    }),

  onDown: select({
    self: $.self,
    'player/y': $['player/y'],
    event: $.event
  })
    .match($.self, "player/y", $['player/y'])
    .match($.self, "~/on/down", $.event)
    .upsert((result) => [result.self, 'player/y', result['player/y'] + 1])
    .commit(),

  onUp: select({
    self: $.self,
    'player/y': $['player/y'],
    event: $.event
  })
    .match($.self, "player/y", $['player/y'])
    .match($.self, "~/on/up", $.event)
    .upsert((result) => [result.self, 'player/y', result['player/y'] - 1])
    .commit(),

  onLeft: select({
    self: $.self,
    'player/x': $['player/x'],
    event: $.event
  })
    .match($.self, "player/x", $['player/x'])
    .match($.self, "~/on/left", $.event)
    .upsert((result) => [result.self, 'player/x', result['player/x'] - 1])
    .commit(),

  onRight: select({
    self: $.self,
    'player/x': $['player/x'],
    event: $.event
  })
    .match($.self, "player/x", $['player/x'])
    .match($.self, "~/on/right", $.event)
    .upsert((result) => [result.self, 'player/x', result['player/x'] + 1])
    .commit(),

  onReset: select({
    self: $.self,
    event: $.event
  })
    .match($.self, "~/on/reset", $.event)
    .upsert((result) => [result.self, 'player/x', 1])
    .upsert((result) => [result.self, 'player/y', 1])
    .commit()
});

const mermaid = analyzeRuleDependencies(rules.rules as any)
console.log(mermaid)

export const spawn = (input: {} = source) => rules.spawn(input, "Dungeon");
