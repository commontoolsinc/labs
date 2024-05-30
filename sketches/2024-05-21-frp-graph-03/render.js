import {
  tap,
  map,
  BehaviorSubject,
  Subject,
  Observable,
} from "https://cdn.jsdelivr.net/npm/rxjs@7.8.1/+esm";
import { createApp } from "https://cdn.jsdelivr.net/npm/petite-vue@0.4.1/+esm";

const workflow = document.getElementById("workflow");
const debugLog = document.getElementById("debug");

export function html(src) {
  return src;
}

export function log(...args) {
  tap((_) => console.log(...args));
}

export function debug(data) {
  render(
    "debug" + "-" + Math.floor(Math.random() * 10000),
    html`<pre class="debug">{{data}}</pre>`,
    {
      data: JSON.stringify(data, null, 2),
    },
    false,
  );
}

export function state(subjects, obj = {}) {
  for (const key in subjects) {
    if (subjects[key] instanceof BehaviorSubject) {
      obj[key] = subjects[key].getValue();
      subjects[key].subscribe((value) => {
        if (value === obj[key]) return;
        obj[key] = value;
      });
      Object.defineProperty(obj, key, {
        get() {
          return subjects[key].getValue();
        },
        set(value) {
          subjects[key].next(value);
        },
        enumerable: true,
        configurable: true,
      });
    } else if (subjects[key] instanceof Observable) {
      obj[key] = null;
      subjects[key].subscribe((value) => {
        if (value === obj[key]) return;
        obj[key] = value;
      });
    } else {
      obj[key] = subjects[key];
    }
  }
  return obj;
}

// export function state(subjects, obj = {}) {
//   for (const key in subjects) {
//     if (
//       typeof subjects[key] === "object" &&
//       subjects[key] instanceof BehaviorSubject
//     ) {
//       Object.defineProperty(obj, key, {
//         get() {
//           return subjects[key].getValue();
//         },
//         set(value) {
//           subjects[key].next(value);
//         },
//         enumerable: true,
//         configurable: true,
//       });
//     } else if (typeof subjects[key] === "object") {
//       obj[key] = createReactiveState(subjects[key]);
//     }
//   }
//   return obj;
// }

export function render(id, htmlString, ctx, log = true) {
  if (log) {
    // debug({ id, htmlString, ctx });
  }

  let newElement = false;
  let el = document.querySelector(`#${id}`);
  if (!el) {
    el = document.createElement("div");
    el.id = id;
    newElement = true;
  }
  el.innerHTML = htmlString;
  if (!log) {
    debugLog.appendChild(el);
  } else if (newElement) {
    workflow.appendChild(el);
  }
  createApp(ctx).mount();
  return el;
}

export function ui(id, html, model) {
  return map(() => {
    return render(id, html, model);
  });
}
