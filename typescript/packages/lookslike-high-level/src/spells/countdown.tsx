import { h, behavior, $, select, Session } from "@commontools/common-system";
import { event, events, set } from "../sugar.js";
import { timer, TIMER } from "../effects/timer.js";

const resolveEmpty = select({ self: $.self }).not(q =>
  q.match($.self, "clicks", $._),
);

const resolveClicks = select({ self: $.self, clicks: $.clicks }).match(
  $.self,
  "clicks",
  $.clicks,
);

const resolveTimer = select({
  self: $.self,
  timer: $.timer,
  remaining: $.remaining,
})
  .match($.self, "timer", $.timer)
  .match($.timer, TIMER.REMAINING, $.remaining);

const CounterEvent = events({
  onReset: "~/on/reset",
  onClick: "~/on/click",
  onCreateTimer: "~/on/create-timer",
});

export const rules = behavior({
  init: resolveEmpty.update(({ self }) => set(self, { clicks: 0 })).commit(),

  viewCount: resolveClicks
    .render(({ clicks, self }) => {
      return (
        <div title={`Clicks ${clicks}`} entity={self}>
          <div>clicks: {clicks}</div>
          <div>no timer</div>
          <div>
            <button onclick={CounterEvent.onClick}>Increas Duration!</button>
            <button onclick={CounterEvent.onReset}>Reset</button>
            <button disabled={clicks == 0} onclick={CounterEvent.onCreateTimer}>
              Create Timer
            </button>
          </div>
        </div>
      );
    })
    .commit(),

  viewCountWithTimer: resolveClicks
    .with(resolveTimer)
    .render(({ clicks, self, remaining }) => {
      const clockStyle =
        "width: 200px; height: 200px; border-radius: 50%; border: 8px solid #444; position: relative; background: linear-gradient(135deg, #f5f5f5, #e0e0e0); box-shadow: inset 0 0 20px rgba(0,0,0,0.2), 0 0 10px rgba(0,0,0,0.1);";
      const handStyle = `position: absolute; left: 50%; top: 50%; transform-origin: 0% 0%; width: 2px; height: 80px; background: linear-gradient(to bottom, #222, #444); transform: rotate(${(remaining / clicks) * 360}deg); box-shadow: 0 0 5px rgba(0,0,0,0.3);`;
      const centerStyle =
        "position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 12px; height: 12px; background: radial-gradient(circle at 30% 30%, #666, #333); border-radius: 50%; box-shadow: 0 0 5px rgba(0,0,0,0.5);";
      const textStyle =
        "position: absolute; width: 100%; text-align: center; top: 70%; font-size: 16px; color: #333; text-shadow: 1px 1px 1px rgba(255,255,255,0.8);";
      const markersStyle =
        "position: absolute; width: 100%; height: 100%; left: 0; top: -49%;";

      return (
        <div title={`Clicks ${clicks} Remaining ${remaining}`} entity={self}>
          <div style={clockStyle}>
            <div style={markersStyle}>
              {[...Array(12)].map((_, i) => (
                <div
                  key={i}
                  style={`position: absolute; left: 50%; top: 50%; width: 2px; height: 10px; background: #666; transform-origin: 50% 95px; transform: rotate(${i * 30}deg);`}
                />
              ))}
            </div>
            <div style={handStyle}></div>
            <div style={centerStyle}></div>
            <div style={textStyle}>
              {remaining} / {clicks}
            </div>
          </div>
          <div>duration: {clicks}</div>
          <div>remaining: {remaining}</div>
          <div>
            <button onclick={CounterEvent.onClick}>Increase duration!</button>
            <button onclick={CounterEvent.onReset}>Reset</button>
            <button onclick={CounterEvent.onCreateTimer}>Create Timer</button>
          </div>
        </div>
      );
    })
    .commit(),

  onReset: event(CounterEvent.onReset)
    .update(({ self }) => set(self, { clicks: 0 }))
    .commit(),

  onClick: event(CounterEvent.onClick)
    .with(resolveClicks)
    .update(({ self, clicks }) => set(self, { clicks: clicks + 1 }))
    .commit(),

  // onTick: resolveTimer
  //     .with(resolveClicks)
  //     .update(({ self, clicks, remaining }) => {
  //         console.log("onTick", clicks, remaining);
  //         return set(self, { clicks: remaining });
  //     })
  //     .commit(),

  onCreateTimer: event(CounterEvent.onCreateTimer)
    .with(resolveClicks)
    .update(({ self, clicks }) => {
      return [timer(self, "timer", clicks, 30)];
    })
    .commit(),
});

export const spawn = (source: {} = { countdown: 3 }) =>
  rules.spawn(source, "Countdown");
