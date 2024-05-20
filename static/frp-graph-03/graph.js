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
import { doLLM } from "./llm.js";
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
const nameUi$ = NameUI();
const nameTagUi$ = NameTagUI();

const cursor$ = CustomCursor();

function policy(v) {
  return v !== "illegal value";
}

let policyTripped = false;

function connect(output, input) {
  output
    .pipe(
      distinctUntilChanged(),
      map((v) => {
        if (!policy(v)) {
          // if (!policyTripped) {
          //   policyTripped = true;
          //   alert("Cannot do!");
          //   requestAnimationFrame(() => {
          //     policyTripped = false;
          //   });
          // }
          return "CANNOT DO";
        }

        return v;
      }),
      tap((v) => input.next(v)),
      // share(),
    )
    .subscribe();
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

combined$.out.ui.subscribe();

connect(app, combined$.in.data);
connect(app, combined$.in.render);

fromEvent(startButton, "click")
  .pipe(
    tap(() => {
      name$.in.value.next("Ben" + Math.floor(Math.random() * 1000));
      nameUi$.in.render.next();
      cursor$.in.render.next();
      combined$.in.render.next();
    }),
  )
  .subscribe();

// function Name() {
//   const name$ = new BehaviorSubject("");

//   name$.subscribe((value) => {
//     console.log("race", value);
//   });

//   const ui$ = fromEvent(startButton, "click")
//     .pipe(
//       map(() => {
//         render(
//           "nameForm",
//           html`<div>
//             <label for="name">Character Name:</label>
//             <input type="text" v-model="name" />
//           </div>`,
//           {
//             get name() {
//               return name$.getValue();
//             },
//             set name(value) {
//               name$.next(value);
//             },
//           },
//         );
//       }),
//     )
//     .subscribe();

//   return {
//     name$,
//     ui$,
//   };
// }

// function Race() {
//   const race$ = new BehaviorSubject();

//   race$.subscribe((value) => {
//     console.log("race", value);
//   });

//   const ui$ = fromEvent(startButton, "click")
//     .pipe(
//       map(() => {
//         render(
//           "raceForm",
//           html`<div>
//             <label for="name">Race:</label>
//             <select v-model="race">
//               <option value="human">Human</option>
//               <option value="elf">Elf</option>
//               <option value="dwarf">Dwarf</option>
//               <option value="orc">Orc</option>
//             </select>
//           </div>`,
//           {
//             set race(value) {
//               race$.next(value);
//             },
//             get race() {
//               return race$.getValue();
//             },
//           },
//         );
//       }),
//     )
//     .subscribe();

//   return {
//     race$,
//     ui$,
//   };
// }

// function Age() {
//   const age$ = new BehaviorSubject(30);
//   const ui$ = fromEvent(startButton, "click")
//     .pipe(
//       map(() => {
//         render(
//           "ageForm",
//           html`<div>
//             <label for="name">Age:</label>
//             <input type="number" v-model="age" />
//           </div>`,
//           {
//             set age(value) {
//               age$.next(value);
//             },
//             get age() {
//               return age$.getValue();
//             },
//           },
//         );
//       }),
//     )
//     .subscribe();

//   return {
//     age$,
//     ui$,
//   };
// }

// function grabViewTemplate(txt) {
//   return txt.match(/```vue\n([\s\S]+?)```/)[1];
// }

// function extractResponse(data) {
//   return data.choices[0].message.content;
// }
// // const name = Name();
// // const race = Race();
// // const age = Age();

// const uiPrompt = `Your task is to generate user interfaces using a vue compatible format. Here is an example component + state combo:

//   \`\`\`vue
//   <div>
//     <label for="name">Age:</label>
//     <input type="number" v-model="age" />
//   </div>
//   \`\`\

//   Extend this pattern, preferring simple unstyled html. Do not include a template tag, surround all components in a div.
//   `;

// const generatedAttributeUI = fromEvent(startButton, "click").pipe(
//   map(
//     () =>
//       `UI with Sliders to adjust STR, DEX, CON, INT, WIS, CHA for the character, assume these are available as \`str\`, \`dex\`, \`con\`, \`int\`, \`wis\`, \`cha\` in the template.`,
//   ),
//   tap((description) => {
//     render("attributesForm", `<div class="description">{{description}}</div>`, {
//       description,
//     });
//   }),
//   mergeMap((description) => {
//     return from(doLLM(description + "Return only the code.", uiPrompt));
//   }),
//   map(extractResponse),
//   map(grabViewTemplate),
//   tap(debug),
// );

// const attributes$ = {
//   str: new BehaviorSubject(10),
//   dex: new BehaviorSubject(10),
//   con: new BehaviorSubject(10),
//   int: new BehaviorSubject(10),
//   wis: new BehaviorSubject(10),
//   cha: new BehaviorSubject(10),
// };

// generatedAttributeUI
//   .pipe(
//     map((template) => {
//       render(
//         "attributesForm",
//         template,
//         Object.keys(attributes$).reduce((acc, key) => {
//           acc[key] = {
//             set(value) {
//               attributes$[key].next(value);
//             },
//             get() {
//               return attributes$[key].getValue();
//             },
//           };
//           return acc;
//         }, {}),
//       );
//     }),
//   )
//   .subscribe();

// const generatedNameUI = fromEvent(startButton, "click").pipe(
//   map(
//     () =>
//       `UI with a text input for the character name. Assume it is called \`name\`.`,
//   ),
//   tap((description) => {
//     render("nameForm", `<div class="description">{{description}}</div>`, {
//       description,
//     });
//   }),
//   mergeMap((description) => {
//     return from(doLLM(description + "Return only the code.", uiPrompt));
//   }),
//   map(extractResponse),
//   map(grabViewTemplate),
//   tap(debug),
// );

// const name$ = new BehaviorSubject("");

// generatedNameUI
//   .pipe(
//     map((template) => {
//       render("nameForm", template, {
//         get name() {
//           return name$.getValue();
//         },
//         set name(value) {
//           name$.next(value);
//         },
//       });
//     }),
//   )
//   .subscribe();

// const generatedRaceUI = fromEvent(startButton, "click").pipe(
//   map(
//     () =>
//       `UI with a select input for the character fantasy race (Orc, Elf, Dwarf, Human). Assume the model is called \`race\`.`,
//   ),
//   tap((description) => {
//     render("raceForm", `<div class="description">{{description}}</div>`, {
//       description,
//     });
//   }),
//   mergeMap((description) => {
//     return from(doLLM(description + "Return only the code.", uiPrompt));
//   }),
//   map(extractResponse),
//   map(grabViewTemplate),
//   tap(debug),
// );

// const race$ = new BehaviorSubject("human");

// generatedRaceUI
//   .pipe(
//     map((template) => {
//       render("raceForm", template, {
//         get race() {
//           return race$.getValue();
//         },
//         set race(value) {
//           race$.next(value);
//         },
//       });
//     }),
//   )
//   .subscribe();

// const generatedAgeUI = fromEvent(startButton, "click").pipe(
//   map(
//     () =>
//       `UI with a text input for the character age. Assume it is called \`age\`.`,
//   ),
//   tap((description) => {
//     render("ageForm", `<div class="description">{{description}}</div>`, {
//       description,
//     });
//   }),
//   mergeMap((description) => {
//     return from(doLLM(description + "Return only the code.", uiPrompt));
//   }),
//   map(extractResponse),
//   map(grabViewTemplate),
//   tap(debug),
// );

// const age$ = new BehaviorSubject(25);

// generatedAgeUI
//   .pipe(
//     map((template) => {
//       render("ageForm", template, {
//         get age() {
//           return age$.getValue();
//         },
//         set age(value) {
//           age$.next(value);
//         },
//       });
//     }),
//   )
//   .subscribe();

// // merge name race and age values together into a single object
// const character$ = combineLatest([name$, race$, age$]).pipe(
//   map(([name, race, age]) => ({ name, race, age })),
//   filter((c) => c.name && c.race && c.age),
// );

// character$.subscribe((data) => {
//   console.log("character", data);
// });

// const backstory$ = character$.pipe(
//   debounceTime(1000),
//   mergeMap((character) => {
//     loading.loading$.next(true);
//     return from(
//       doLLM(
//         JSON.stringify(character),
//         "Write a possible backstory for this fantasy character.",
//       ),
//     );
//   }),
//   tap(debug),
//   tap((data) => loading.loading$.next(false)),
// );

// const characterWithBackstory$ = combineLatest([character$, backstory$]).pipe(
//   map(([c, backstory]) => ({ ...c, backstory })),
// );

// function Loading() {
//   const loading$ = new BehaviorSubject();

//   const ui$ = loading$
//     .pipe(
//       map((data) => {
//         render(
//           "loadingIndicator",
//           html`<div>{{ loading ? "loading..." : ""}}</div>`,
//           { loading: data },
//         );
//       }),
//     )
//     .subscribe();

//   return {
//     loading$,
//     ui$,
//   };
// }

// const loading = Loading();

// function BioCard() {
//   const bioUI$ = characterWithBackstory$.subscribe((character) => {
//     // Assuming character is deemed valid if name, race, and age are present
//     if (
//       character &&
//       character.name &&
//       character.race &&
//       character.age &&
//       character.backstory
//     ) {
//       render(
//         "bioCard",
//         html`<div class="bio-card">
//           <h2>Character Biography</h2>
//           <p><strong>Name:</strong> {{ name }}</p>
//           <p><strong>Race:</strong> {{ race }}</p>
//           <p><strong>Age:</strong> {{ age }}</p>
//           <p>
//             <strong>Backstory:</strong> {{ backstory.choices[0].message.content
//             }}
//           </p>
//         </div>`,
//         // Context mapping character properties for rendering
//         {
//           get name() {
//             return character.name;
//           },
//           get race() {
//             return character.race;
//           },
//           get age() {
//             return character.age;
//           },
//           get backstory() {
//             return character.backstory;
//           },
//         },
//       );
//     }
//   });

//   return {
//     bioUI$,
//   };
// }

// BioCard();
