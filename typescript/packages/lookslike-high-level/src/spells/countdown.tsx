import { h, behavior, $, select, Session } from "@commontools/common-system";
import { event, events, set } from "../sugar.js";
import { timer, TIMER } from "../effects/timer.js";

const resolveEmpty = select({ self: $.self }).not(q => q.match($.self, "clicks", $._));

const resolveClicks = select({ self: $.self, clicks: $.clicks }).match(
    $.self,
    "clicks",
    $.clicks,
);

const resolveTimer = select({ self: $.self, timer: $.timer, remaining: $.remaining })
    .match($.self, "timer", $.timer)
    .match($.timer, TIMER.REMAINING, $.remaining)


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
                <div title={`Clicks ${clicks}`} entity={self} >
                    <div>clicks: {clicks}</div>
                    <div>no timer</div>
                    <div>
                        <button onclick={CounterEvent.onClick}>Click me!</button>
                        <button onclick={CounterEvent.onReset}>Reset</button>
                        <button onclick={CounterEvent.onCreateTimer}>Create Timer</button>
                    </div>
                </div>
            );
        })
        .commit(),

    viewCountWithTimer: resolveClicks.with(resolveTimer)
        .render(({ clicks, self, remaining }) => {
            return (
                <div title={`Clicks ${clicks} Remaining ${remaining}`} entity={self} >
                    <div>clicks: {clicks}</div>
                    <div>remaining: {remaining}</div>
                    <div>
                        <button onclick={CounterEvent.onClick}>Click me!</button>
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
            return [
                timer(self, "timer", clicks)
            ];
        })
        .commit(),
});

export const spawn = (source: {} = { countdown: 3 }) =>
    rules.spawn(source, "Countdown");