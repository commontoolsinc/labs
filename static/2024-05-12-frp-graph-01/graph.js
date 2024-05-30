import {
  mergeMap,
  map,
  fromEvent,
  from,
  tap,
  Subject,
} from "https://cdn.jsdelivr.net/npm/rxjs@7.8.1/+esm";
import { createApp } from "https://cdn.jsdelivr.net/npm/petite-vue@0.4.1/+esm";
export function start() {}

const startButton = document.getElementById("startWorkflow");
const workflow = document.getElementById("workflow");
const debugLog = document.getElementById("debug");

function html(src) {
  return src;
}

function log(...args) {
  tap((_) => console.log(...args));
}

function debug(data) {
  render(
    "debug",
    html`<pre class="debug">{{data}}</pre>`,
    {
      data: JSON.stringify(data, null, 2),
    },
    false,
  );
}

function render(id, htmlString, ctx, log = true) {
  if (log) {
    debug({ id, htmlString, ctx });
  }

  const el = document.createElement("div");
  el.id = id + "-" + Math.floor(Math.random() * 10000);
  el.innerHTML = htmlString;
  if (!log) {
    debugLog.appendChild(el);
  } else {
    workflow.appendChild(el);
  }
  createApp(ctx).mount();
}

const nameForm$ = fromEvent(startButton, "click")
  .pipe(
    map(() => {
      render(
        "nameForm",
        html`<div>
          <h2>Github User Lookup</h2>
          <label for="name">Enter a Github username:</label>
          <input type="text" v-model="name" />
          <button @click="submit()">Submit</button>
        </div>`,
        {
          name: "",
          submit() {
            nameSubmitted$.next(this.name);
          },
        },
      );
    }),
  )
  .subscribe();

const nameSubmitted$ = new Subject();

const githubData$ = nameSubmitted$.pipe(
  mergeMap((name) => {
    const githubApiUrl = `https://api.github.com/users/${name}/repos`;
    loading$.next(true);
    return from(fetch(githubApiUrl).then((response) => response.json()));
  }),
  tap(debug),
  tap((data) => loading$.next(false)),
);

const loading$ = new Subject();

const loadingIndicator$ = loading$
  .pipe(
    map((data) => {
      render(
        "loadingIndicator",
        html`<div>{{ loading ? "loading..." : ""}}</div>`,
        { loading: data },
      );
    }),
  )
  .subscribe();

const githubDataTable$ = githubData$
  .pipe(
    map((data) => {
      render(
        "githubDataTable",
        html`<div v-scope="{ count: 0 }">
          <table>
            <tr>
              <th>Name</th>
              <th>Full Name</th>
              <th>Description</th>
              <th>Stars</th>
              <th>Forks</th>
            </tr>
            <tr v-for="item in items">
              <td>{{ item.name }}</td>
              <td>{{ item.full_name }}</td>
              <td>{{ item.description }}</td>
              <td>{{ item.stargazers_count }}</td>
              <td>{{ item.forks_count }}</td>
            </tr>
          </table>
        </div>`,
        { items: data },
      );
    }),
  )
  .subscribe();
