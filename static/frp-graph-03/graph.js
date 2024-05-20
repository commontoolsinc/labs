import {
  mergeMap,
  map,
  fromEvent,
  distinct,
  distinctUntilChanged,
  from,
  of,
  filter,
  combineLatest,
  debounceTime,
  share,
  tap,
  Subject,
  BehaviorSubject,
} from "https://cdn.jsdelivr.net/npm/rxjs@7.8.1/+esm";
import { doLLM, extractResponse, grabViewTemplate, uiPrompt } from "./llm.js";
import { render, html, debug, log, state, ui } from "./render.js";

const startButton = document.getElementById("startWorkflow");

// nodes have inputs and outputs
// for a behaviour subject the input and output are simply its value

function BehaviourNode(constant) {
  const value$ = new BehaviorSubject(constant);

  return {
    in: {
      value: value$,
    },
    out: {
      value: value$,
    },
  };
}

function CustomCursor() {
  const render$ = new Subject();
  const cursorPosition$ = new BehaviorSubject({ x: 0, y: 0 });

  const ui$ = render$.pipe(
    ui(
      "cursor",
      html`<div>
        <div
          v-effect="$el.style.backgroundColor = popup ? 'red' : 'blue';"
          style="width: 100px; height: 100px;"
          class="hover"
          @mouseenter="mouseEnter"
          @mousemove="mouseMove"
          @mouseleave="mouseLeave"
        >
          {{x}}, {{y}}
        </div>
      </div>`,
      state({
        popup: false,
        x: 0,
        y: 0,
        mouseEnter(event) {
          this.popup = true;
        },
        mouseLeave(event) {
          this.popup = false;
        },
        mouseMove(event) {
          // get position within element bounds
          this.x = event.offsetX;
          this.y = event.offsetY;
          cursorPosition$.next({ x: event.offsetX, y: event.offsetY });
        },
      }),
    ),
  );

  return {
    in: {
      render: render$,
    },
    out: {
      cursor: cursorPosition$,
      ui: ui$,
    },
  };
}

const name$ = BehaviourNode("");
const nameUi$ = GeneratedNameUI();
const nameTagUi$ = GeneratedNameTagUI();
const danger$ = DangerousUI();

const cursor$ = CustomCursor();

function policy(v) {
  console.log("policy scan", v);

  if (v === "illegal value") return;

  if (typeof v === "string") {
    return v.indexOf("<script") < 0 && v.indexOf("alert") < 0;
  }

  return true;
}

let policyTripped = false;

function applyPolicy() {
  return map((v) => {
    if (!policy(v)) {
      // if (!policyTripped) {
      //   policyTripped = true;
      //   alert("Cannot do!");
      //   requestAnimationFrame(() => {
      //     policyTripped = false;
      //   });
      // }
      return "<div>CANNOT DO</div>";
    }

    return v;
  });
}

function connect(output, input) {
  output
    .pipe(
      distinctUntilChanged(),
      applyPolicy(),
      tap((v) => input.next(v)),
      // share(),
    )
    .subscribe();
}

function ground(output) {
  connect(output, new Subject());
}

function NameTagUI() {
  const render$ = new Subject();
  const name$ = new BehaviorSubject("");

  const ui$ = render$.pipe(
    ui(
      "nameTag",
      html`<div>
        <h1>{{name}}</h1>
      </div>`,
      state({ name: name$ }),
    ),
  );

  return {
    in: {
      render: render$,
      name: name$,
    },
    out: {
      ui: ui$,
    },
  };
}

function NameUI() {
  const render$ = new Subject();
  const name$ = new BehaviorSubject("");

  const ui$ = render$.pipe(
    ui(
      "nameForm",
      html`<div>
        <label for="name">Character Name:</label>
        <input type="text" v-model="name" />
      </div>`,
      state({ name: name$ }),
    ),
  );

  return {
    in: {
      render: render$,
      name: name$,
    },
    out: {
      name: name$,
      ui: ui$,
    },
  };
}

function placeholder(id) {
  return tap((description) => {
    render(id, `<div class="description">{{description}}</div>`, {
      description,
    });
  });
}

function imagine(id, prompt) {
  return (v) =>
    v.pipe(
      map(() => prompt),
      placeholder(id),
      mergeMap((description) =>
        from(doLLM(description + "Return only the code.", uiPrompt)),
      ),
      map(extractResponse),
      map(grabViewTemplate),
      applyPolicy(),
    );
}

function DangerousUI() {
  const render$ = new Subject();
  const generate$ = new Subject();

  const id = "dangerUi";

  const html$ = new BehaviorSubject("");
  ground(
    generate$.pipe(
      imagine(
        id,
        `Write a nefarious component to defeat petite-vue's templating and alert('pwned')`,
      ),
      tap(debug),
      tap((html) => {
        html$.next(html);
        render$.next();
      }),
    ),
  );
  const ui$ = render$.pipe(map(() => render(id, html$.getValue(), {})));

  return {
    in: {
      render: render$,
      generate: generate$,
    },
    out: {
      ui: ui$,
      html: html$,
    },
  };
}

function GeneratedNameUI() {
  const render$ = new Subject();
  const generate$ = new Subject();
  const name$ = new BehaviorSubject("");

  const id = "nameForm";

  const html$ = new BehaviorSubject("");
  ground(
    generate$.pipe(
      imagine(
        id,
        `Text input for the character name. Assume it is called \`name\`.`,
      ),
      tap(debug),
      tap((html) => {
        html$.next(html);
        render$.next();
      }),
    ),
  );

  const ui$ = render$.pipe(
    map(() => render(id, html$.getValue(), state({ name: name$ }))),
  );

  return {
    in: {
      render: render$,
      generate: generate$,
      name: name$,
    },
    out: {
      name: name$,
      ui: ui$,
      html: html$,
    },
  };
}

function GeneratedNameTagUI() {
  const render$ = new Subject();
  const generate$ = new Subject();
  const name$ = new BehaviorSubject("");
  const id = "nameTag";

  const html$ = new BehaviorSubject("");
  ground(
    generate$.pipe(
      imagine(
        id,
        `A header displaying the character's name in fancy text. Assume it is called \`name\`.`,
      ),
      tap(debug),
      tap((html) => {
        html$.next(html);
        render$.next();
      }),
    ),
  );
  const ui$ = render$.pipe(
    map(() => render(id, html$.getValue(), state({ name: name$ }))),
  );

  return {
    in: {
      render: render$,
      generate: generate$,
      name: name$,
    },
    out: {
      name: name$,
      ui: ui$,
      html: html$,
    },
  };
}

connect(name$.out.value, nameUi$.in.name);
connect(nameUi$.out.name, nameTagUi$.in.name);
connect(nameUi$.out.name, name$.in.value);

connect(nameUi$.out.name, nameTagUi$.in.render);

const app = combineLatest([
  name$.out.value,
  nameUi$.out.ui,
  nameTagUi$.out.ui,
  cursor$.out.ui,
  cursor$.out.cursor,
]).pipe(
  map(([name, nameUi, nameTagUi, cursorUi, cursor]) => ({
    name,
    nameUi,
    nameTagUi,
    cursorUi,
    cursor,
  })),
);

app.subscribe(console.log);

function CombinedDataUi() {
  const render$ = new Subject();
  const data$ = new BehaviorSubject({});

  const ui$ = render$.pipe(
    ui(
      "combinedData",
      html`<div>
        <label>Name:</label>
        <span>{{data.name}}</span>
        <label>Cursor:</label>
        <div
          style="width: 100px; height: 100px; position: relative;"
          class="hover"
        >
          {{data.cursor.x}}, {{data.cursor.y}}
          <div
            v-effect="$el.style.left = data.cursor.x + 'px'; $el.style.top = data.cursor.y + 'px';"
            style="position: absolute; width: 4px; height: 4px; background: red;"
          ></div>
        </div>
      </div>`,
      state({ data: data$ }),
    ),
  );

  return {
    in: {
      render: render$,
      data: data$,
    },
    out: {
      ui: ui$,
    },
  };
}

const combined$ = CombinedDataUi();

ground(combined$.out.ui);
ground(danger$.out.ui);

connect(app, combined$.in.data);
connect(app, combined$.in.render);

ground(
  fromEvent(startButton, "click").pipe(
    tap(() => {
      name$.in.value.next("Ben" + Math.floor(Math.random() * 1000));
      nameUi$.in.generate.next();
      nameTagUi$.in.generate.next();
      danger$.in.generate.next();

      cursor$.in.render.next();
      // combined$.in.render.next();
    }),
  ),
);
