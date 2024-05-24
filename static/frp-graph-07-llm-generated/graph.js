import {
  combineLatest,
  debounceTime,
  delay,
  distinctUntilChanged,
  filter,
  from,
  fromEvent,
  map,
  mergeMap,
  BehaviorSubject,
  share,
  switchMap,
  tap,
} from "https://cdn.jsdelivr.net/npm/rxjs@7.8.1/+esm";
import { connect, ground } from "./connect.js";
import { SerializedGeneratedUI } from "./nodes/SerializedGeneratedUI.js";
import { SerializedLLMNode } from "./nodes/SerializedLLMNode.js";

// UI component to collect user's name
const nameInputUI = SerializedGeneratedUI("nameInput", {
  inputs: {
    prompt: {
      shape: {
        kind: "string",
        default: "A text input field to enter your name.",
      },
    },
    render: { shape: { kind: "unit" } },
  },
  outputs: {
    name: { shape: { kind: "string", default: "" } },
  },
  contentType: "GeneratedUI",
});

// UI component to collect user's favorite color
const colorInputUI = SerializedGeneratedUI("colorInput", {
  inputs: {
    prompt: {
      shape: {
        kind: "string",
        default:
          "An input field to enter your favorite color, stored in `color`.",
      },
    },
    render: { shape: { kind: "unit" } },
  },
  outputs: {
    color: { shape: { kind: "string", default: "" } },
  },
  contentType: "GeneratedUI",
});

// LLM node to generate a poem
const generatePoemNode = SerializedLLMNode({
  inputs: {
    name: {
      shape: {
        kind: "string",
      },
    },
    color: {
      shape: {
        kind: "string",
      },
    },
    uiPrompt: {
      shape: {
        kind: "string",
        default: `Generate a short poem about {{name}} and their favorite color {{color}}.`,
      },
    },
    systemPrompt: {
      shape: {
        kind: "string",
        default:
          "Respond with a JSON object with the poem text in the field `poem`, surrounded in a ```json``` block.",
      },
    },
  },
  outputs: {
    result: { shape: { kind: "string", default: "" } },
  },
  contentType: "LLMResult",
});

// UI component to display the generated poem
const poemDisplayUI = SerializedGeneratedUI("poemDisplay", {
  inputs: {
    prompt: {
      shape: {
        kind: "string",
        default: "Display the field `poem` in a blockquote.",
      },
    },
    render: { shape: { kind: "unit" } },
  },
  outputs: {
    poem: { shape: { kind: "string", default: {} } },
  },
  contentType: "GeneratedUI",
});

// Grounding the UI components
ground(nameInputUI.out.ui);
ground(colorInputUI.out.ui);
ground(poemDisplayUI.out.ui);

// Wiring the nodes together
connect(nameInputUI.out.name, generatePoemNode.in.name);
connect(colorInputUI.out.color, generatePoemNode.in.color);

const poem$ = generatePoemNode.out.result.pipe(map((v) => v.poem));

connect(poem$, poemDisplayUI.out.poem);
connect(poem$, poemDisplayUI.in.render);

generatePoemNode.out.result.subscribe((poem) => {
  console.log(poem);
});

// Trigger rendering of the UI components
