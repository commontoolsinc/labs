import { Reference } from "merkle-reference";
import { changes, Doc, Spell } from "./spell.jsx";
import { Collection, defaultTo, Transact } from "../sugar.js";
import { h, $, select } from "@commontools/common-system";

type CommentsState = {
  title: string;
  description: string;
  meta: Reference | null;
}

type Meta = {
  category: string;
  submittedAt: string;
}

export class CommentBoxSpell extends Spell<CommentsState> {
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
          <common-charm id={meta?.toString()} key={meta?.toString()} spell={() => new MetadataSpell().compile()} entity={() => meta} />
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

export function execute<T extends Record<string, any>, S extends Spell<T>>(id: Reference, SpellClass: new () => S) {
  const spell = new SpellClass().compile()
  return spell.spawn(id);
}
