import {
  mergeMap,
  map,
  fromEvent,
  from,
  filter,
  combineLatest,
  debounceTime,
  tap,
  Subject,
  BehaviorSubject,
} from "https://cdn.jsdelivr.net/npm/rxjs@7.8.1/+esm";
import { createApp } from "https://cdn.jsdelivr.net/npm/petite-vue@0.4.1/+esm";
import Instructor from "https://cdn.jsdelivr.net/npm/@instructor-ai/instructor@1.2.1/+esm";
import OpenAI from "https://cdn.jsdelivr.net/npm/openai@4.40.1/+esm";

export function start() {}

let apiKey = localStorage.getItem("apiKey");

if (!apiKey) {
  // Prompt the user for the API key if it doesn't exist
  const userApiKey = prompt("Please enter your API key:");

  if (userApiKey) {
    // Save the API key in localStorage
    localStorage.setItem("apiKey", userApiKey);
    apiKey = userApiKey;
  } else {
    // Handle the case when the user cancels or doesn't provide an API key
    alert("API key not provided. Some features may not work.");
  }
}

const openai = new OpenAI({
  apiKey: apiKey,
  dangerouslyAllowBrowser: true,
});

let model = "gpt-4o";
// let model = "gpt-4-turbo-preview";
const client = Instructor({
  client: openai,
  mode: "JSON",
});

async function doLLM(input, system, response_model) {
  try {
    return await client.chat.completions.create({
      messages: [
        { role: "user", content: input },
        { role: "system", content: system },
      ],
      model,
    });
  } catch (error) {
    console.error("Error analyzing text:", error);
  }
}

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
    "debug" + "-" + Math.floor(Math.random() * 10000),
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

  let el = document.querySelector(`#${id}`);
  if (!el) {
    el = document.createElement("div");
    el.id = id;
  }
  el.innerHTML = htmlString;
  if (!log) {
    debugLog.appendChild(el);
  } else {
    workflow.appendChild(el);
  }
  createApp(ctx).mount();
}

function Name() {
  const name$ = new BehaviorSubject("");

  name$.subscribe((value) => {
    console.log("race", value);
  });

  const ui$ = fromEvent(startButton, "click")
    .pipe(
      map(() => {
        render(
          "nameForm",
          html`<div>
            <label for="name">Character Name:</label>
            <input type="text" v-model="name" />
          </div>`,
          {
            get name() {
              return name$.getValue();
            },
            set name(value) {
              name$.next(value);
            },
          },
        );
      }),
    )
    .subscribe();

  return {
    name$,
    ui$,
  };
}

function Race() {
  const race$ = new BehaviorSubject();

  race$.subscribe((value) => {
    console.log("race", value);
  });

  const ui$ = fromEvent(startButton, "click")
    .pipe(
      map(() => {
        render(
          "raceForm",
          html`<div>
            <label for="name">Race:</label>
            <select v-model="race">
              <option value="human">Human</option>
              <option value="elf">Elf</option>
              <option value="dwarf">Dwarf</option>
              <option value="orc">Orc</option>
            </select>
          </div>`,
          {
            set race(value) {
              race$.next(value);
            },
            get race() {
              return race$.getValue();
            },
          },
        );
      }),
    )
    .subscribe();

  return {
    race$,
    ui$,
  };
}

function Age() {
  const age$ = new BehaviorSubject(30);

  age$.subscribe((value) => {
    console.log("age", value);
  });

  const ui$ = fromEvent(startButton, "click")
    .pipe(
      map(() => {
        render(
          "ageForm",
          html`<div>
            <label for="name">Age:</label>
            <input type="number" v-model="age" />
          </div>`,
          {
            set age(value) {
              age$.next(value);
            },
            get age() {
              return age$.getValue();
            },
          },
        );
      }),
    )
    .subscribe();

  return {
    age$,
    ui$,
  };
}

const name = Name();
const race = Race();
const age = Age();

// merge name race and age values together into a single object
const character$ = combineLatest([name.name$, race.race$, age.age$]).pipe(
  map(([name, race, age]) => ({ name, race, age })),
  filter((c) => c.name && c.race && c.age),
);

character$.subscribe((data) => {
  console.log("character", data);
});

const backstory$ = character$.pipe(
  debounceTime(1000),
  mergeMap((character) => {
    loading.loading$.next(true);
    return from(
      doLLM(
        JSON.stringify(character),
        "Write a possible backstory for this fantasy character.",
      ),
    );
  }),
  tap(debug),
  tap((data) => loading.loading$.next(false)),
);

const characterWithBackstory$ = combineLatest([character$, backstory$]).pipe(
  map(([c, backstory]) => ({ ...c, backstory })),
);

function Loading() {
  const loading$ = new BehaviorSubject();

  const ui$ = loading$
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

  return {
    loading$,
    ui$,
  };
}

const loading = Loading();

function BioCard() {
  const bioUI$ = characterWithBackstory$.subscribe((character) => {
    // Assuming character is deemed valid if name, race, and age are present
    if (
      character &&
      character.name &&
      character.race &&
      character.age &&
      character.backstory
    ) {
      render(
        "bioCard",
        html`<div class="bio-card">
          <h2>Character Biography</h2>
          <p><strong>Name:</strong> {{ name }}</p>
          <p><strong>Race:</strong> {{ race }}</p>
          <p><strong>Age:</strong> {{ age }}</p>
          <p>
            <strong>Backstory:</strong> {{ backstory.choices[0].message.content
            }}
          </p>
        </div>`,
        // Context mapping character properties for rendering
        {
          get name() {
            return character.name;
          },
          get race() {
            return character.race;
          },
          get age() {
            return character.age;
          },
          get backstory() {
            return character.backstory;
          },
        },
      );
    }
  });

  return {
    bioUI$,
  };
}

BioCard();
