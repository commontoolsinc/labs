import { html } from "@commontools/common-html";
import { recipe, lift, NAME, UI } from "../builder/index.js";

export const prompt = recipe<{ title: string }>("prompt", ({ title }) => {
  // this kinda makes sense but feels painful?  better syntactic sugar?
  const url = lift<{ title: string }, string>(
    ({ title }) =>
      `https://ct-img.m4ke.workers.dev/?prompt=${encodeURIComponent(title)}`,
  )({ title });

  return {
    [NAME]: title,
    [UI]: html`<div>
      Prompt: ${title}<br /><img src=${url} width="100%" />
    </div>`,
  };
});
