import {
  mergeMap,
  map,
  from,
  tap,
} from "https://cdn.jsdelivr.net/npm/rxjs@7.8.1/+esm";
import { doLLM, extractResponse, grabViewTemplate, uiPrompt } from "./llm.js";
import { applyPolicy } from "./policy.js";
import { render } from "./render.js";

export function placeholder(id) {
  return tap((description) => {
    render(id, `<div class="description">{{description}}</div>`, {
      description,
    });
  });
}

export function imagine(id) {
  return (prompt) =>
    prompt.pipe(
      placeholder(id),
      mergeMap((description) =>
        from(
          doLLM(
            description + "Return only the code. Do not include a script tag.",
            uiPrompt,
          ),
        ),
      ),
      map(extractResponse),
      map(grabViewTemplate),
      applyPolicy(),
    );
}
