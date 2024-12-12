import { Reference } from "merkle-reference";
import { changes, Charm, Doc, Spell } from "./spell.jsx";
import { Transact } from "../sugar.js";
import { h } from "@commontools/common-system";

type DemoState = {
  title: string;
  description: string;
  meta: Reference | null;
}

type Meta = {
  category: string;
  submittedAt: string;
}

function Metadata({ entity }: { entity: Reference }) {
  return <Charm spell={new MetadataSpell().compile()} self={entity} />
}

export class DemoSpell extends Spell<DemoState> {
  constructor() {
    super();

    this.addEventListener("random", (self) => {
      const metadata: Doc<Meta> = new Doc({
        category: 'Demo category ' + Math.random(),
        submittedAt: new Date().toISOString(),
      });

      return changes(
        metadata.save(),
        this.set(self, { meta: metadata.id() })
      );
    });
  }

  override init() {
    return {
      title: 'Class Syntax Demo',
      description: 'It has an embedded doc!',
      meta: null
    };
  }

  override render({ self, description, title, meta }) {
    return (
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
        <pre>{JSON.stringify(meta, null, 2)}</pre>
        {meta && <div>
          <Metadata entity={meta} />
        </div>}
        <common-form onsubmit={'~/on/submit'}>
          <common-input type="text" name="message" />
        </common-form>
        <common-button onclick={'~/on/random'}>Random</common-button>
      </div>
    );
  }
}

class MetadataSpell extends Spell<Meta> {
  constructor() {
    super();

    this.addEventListener('update', (self, ev) => {
      return changes(
        Transact.set(self, { category: ev.detail.value })
      )
    })
  }

  override init() {
    return {
      category: 'Default category',
      submittedAt: 'n/a'
    };
  }

  override render({ self, category, submittedAt }) {
    return (
      <div>
        <common-input type="text" name="category" value={category} oncommon-blur="~/on/update" />
        <small>{submittedAt}</small>
      </div>
    );
  }
}
