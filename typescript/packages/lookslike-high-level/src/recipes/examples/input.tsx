import { handler, recipe } from "@commontools/common-builder";
import { h } from "@commontools/common-html";

export const input = recipe(
  "Input with JSX",
  ({ value }: { value: string }) => {
    const onChange = handler<InputEvent, { value: string }>((e, state) => {
      state.value = (e.target as HTMLInputElement).value;
    });

    return <input value={value} oninput={onChange({ value })}></input>;
  },
);
