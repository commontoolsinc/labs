import { h, $, behavior, select } from "@commontools/common-system";
import { event, events } from "../sugar.js";
import { applyTheme, princessTheme, PrincessTheme, resolveTheme, scienceTheme, ScienceTheme, wizardTheme } from "./stickers/theme.jsx";
import { mixin } from "../sugar/mixin.js";

const HelloWorldEvent = events({
  onAlert: '~/on/alert',
})
const spell = behavior({
  ...mixin(PrincessTheme),

  view: select({ self: $.self })
    .with(resolveTheme)
    .render(({ self, theme }) => {
      const styles = {
        container: `border: ${theme.borderWidth} solid ${theme.borderColor}; border-radius: ${theme.roundness}; padding: 20px; background: ${theme.background}; text-align: center;`,
        heading: `color: ${theme.accent}; font-family: ${theme.font};`,
        text: `color: ${theme.accent}; font-size: 18px;`,
        button: `background: ${theme.accent}; border-radius: ${theme.roundness}; color: white; border: none; padding: 10px 20px; border-radius: ${theme.roundness}px; font-size: 16px; cursor: pointer; transition: all 0.3s; font-family: ${theme.font};`
      };

      return <div entity={self} title="Hello World" style={styles.container}>
        <h1 style={styles.heading}>Hello World</h1>
        <p style={styles.text}>This is a charm.</p>
        <button type="button" style={styles.button} onclick={HelloWorldEvent.onAlert}>Science Theme</button>
        <span style="margin: 0 10px"></span>
        <button type="button" style={styles.button} onclick={HelloWorldEvent.onAlert + "/princess"}>Princess Theme</button>
        <span style="margin: 0 10px"></span>
        <button type="button" style={styles.button} onclick={HelloWorldEvent.onAlert + "/wizard"}>Wizard Theme</button>
      </div>
    })
    .commit(),

  onClick: event(HelloWorldEvent.onAlert)
    .update(({ self }) => {
      return [
        ...applyTheme(self, scienceTheme)
      ];
    })
    .commit(),

  onPrincessClick: event(HelloWorldEvent.onAlert + "/princess")
    .update(({ self }) => {
      return [
        ...applyTheme(self, princessTheme)
      ];
    })
    .commit(),

  onWizardClick: event(HelloWorldEvent.onAlert + "/wizard")
    .update(({ self }) => {
      return [
        ...applyTheme(self, wizardTheme)
      ];
    })
    .commit()
});

export const spawn = (source: {} = { hello: 1 }) => spell.spawn(source, "Hello World");
