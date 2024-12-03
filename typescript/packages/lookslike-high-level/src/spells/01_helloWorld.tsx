import { h, $, behavior, select } from "@commontools/common-system";
import { event, events } from "../sugar.js";

const HelloWorldEvent = events({
  onAlert: '~/on/alert',
})

const styles = {
  container: "border: 3px solid #ff69b4; border-radius: 25px; padding: 20px; background: #fff0f5; text-align: center;",
  heading: "color: #ff1493; font-family: cursive;",
  text: "color: #ff69b4; font-size: 18px;",
  button: "background: #ff69b4; color: white; border: none; padding: 10px 20px; border-radius: 15px; font-size: 16px; cursor: pointer; transition: all 0.3s;"
};

const spell = behavior({
  view: select({ self: $.self })
    .render(({ self }) => {
      return <div entity={self} title="Hello World" style={styles.container}>
        <h1 style={styles.heading}>Hello World</h1>
        <p style={styles.text}>This is a charm.</p>
        <button type="button" style={styles.button} onclick={HelloWorldEvent.onAlert}>Click me</button>
      </div>
    })
    .commit(),

  onClick: event(HelloWorldEvent.onAlert)
    .update(({ self }) => {
      alert('Hello from ' + self.toString());
      return [];
    })
    .commit()
});

export const spawn = (source: {} = { hello: 1 }) => spell.spawn(source, "Hello World");
