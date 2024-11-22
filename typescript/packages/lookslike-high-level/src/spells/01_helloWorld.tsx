import { h, $, behavior, select } from "@commontools/common-system";
import { event, Events } from "../sugar/event.js";

const events: Events = {
  onAlert: '~/on/alert',
}

const HelloWorld = select({ self: $.self })

const spell = behavior({
  view: select({ self: $.self })
    .render(({ self }) => {
      return <div entity={self} title="Hello World">
        <h1>Hello World</h1>
        <p>This is a spell.</p>
        <button type="button" onclick={events.onAlert}>Click me</button>
      </div>
    })
    .commit(),

  onClick: event(events.onAlert)
    .update(({ self }) => {
      alert('Hello from ' + self.toString());
      return [];
    })
    .commit()
});

export const spawn = (input: {} = { hello: 1 }) => spell.spawn(input);
