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
import { TextLLMNode } from "./nodes/TextLLMNode.js";
import { JSONLLMNode } from "./nodes/JSONLLMNode.js";
import { CodeNode } from "./nodes/CodeNode.js";

const monster1DescriptionUI = SerializedGeneratedUI("monster1Description", {
  inputs: { prompt: { shape: { kind: "string", default: "Describe Monster 1:" } } },
  outputs: { description: { shape: { kind: "string", default: "" } } }
});

const monster2DescriptionUI = SerializedGeneratedUI("monster2Description", {
  inputs: { prompt: { shape: { kind: "string", default: "Describe Monster 2:" } } },
  outputs: { description: { shape: { kind: "string", default: "" } } }
});

const monster1DataNode = JSONLLMNode({
  inputs: {
    description: { shape: { kind: "string" } },
    prompt: { shape: { kind: "string", default: "Generate data for Monster 1: {{description}}." } }
  },
  outputs: { result: { shape: { kind: "object", default: {}, description: "generated data for Monster 1" } } }
});

const monster2DataNode = JSONLLMNode({
  inputs: {
    description: { shape: { kind: "string" } },
    prompt: { shape: { kind: "string", default: "Generate data for Monster 2: {{description}}." } }
  },
  outputs: { result: { shape: { kind: "object", default: {}, description: "generated data for Monster 2" } } }
});

const battlePromptNode = CodeNode({
  inputs: {
    monster1Data: { shape: { kind: "object" } },
    monster2Data: { shape: { kind: "object" } }
  },
  outputs: {
    prompt: {
      shape: {
        kind: "string",
        default: "Generate a battle description between Monster 1 and Monster 2 based on their data."
      }
    }
  },
  fn: ({ monster1Data, monster2Data }) => {
    const monster1 = JSON.stringify(monster1Data, null, 2);
    const monster2 = JSON.stringify(monster2Data, null, 2);
    return {
      prompt: `Describe a battle between these two monsters based on their data:
Monster 1: ${monster1}
Monster 2: ${monster2}
Determine the victor based on their strengths and weaknesses.`
    };
  }
});

const battleResultNode = TextLLMNode({
  inputs: {
    prompt: { shape: { kind: "string" } },
    systemPrompt: {
      shape: {
        kind: "string",
        default: "Generate a detailed battle description between the two monsters and determine the victor. Respond only with the battle description."
      }
    }
  },
  outputs: { result: { shape: { kind: "string", default: "", description: "generated battle description and victor" } } }
});

const battleDisplay = SerializedGeneratedUI("battleDisplay", {
  inputs: {
    battleResult: { shape: { kind: "string", default: "", description: "Display the generated battle result with appropriate styling." } }
  },
  outputs: {}
});

ground(monster1DescriptionUI.out.ui);
ground(monster2DescriptionUI.out.ui);
ground(battleDisplay.out.ui);

connect(monster1DescriptionUI.out.description, monster1DataNode.in.description);
connect(monster2DescriptionUI.out.description, monster2DataNode.in.description);

connect(monster1DataNode.out.result, battlePromptNode.in.monster1Data);
connect(monster2DataNode.out.result, battlePromptNode.in.monster2Data);

connect(battlePromptNode.out.prompt, battleResultNode.in.prompt);

connect(battleResultNode.out.result, battleDisplay.in.battleResult);
