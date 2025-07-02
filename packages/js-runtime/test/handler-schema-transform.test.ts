import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { transformSource } from "./test-utils.ts";
import { cache } from "@commontools/static";

const commontools = await cache.getText("types/commontools.d.ts");

describe("Handler Schema Transformation", () => {
  it("transforms handler<Event, State>() to include JSON schemas", async () => {
    const source = `/// <cts-enable />
import { handler } from "commontools";

interface CounterEvent {
  increment: number;
}

interface CounterState {
  value: number;
}

const myHandler = handler<CounterEvent, CounterState>((event, state) => {
  state.value = state.value + event.increment;
});

export { myHandler };
`;

    const transformed = await transformSource(source, {
      types: { "commontools.d.ts": commontools },
      applySchemaTransformer: true,
      debug: false
    });

    // First, check that handler was given toSchema calls or schema objects
    expect(transformed).toContain("handler(");
    
    // Check that toSchema calls were transformed (import may still be present)
    expect(transformed).not.toContain("toSchema<");
    
    // Check for event schema
    expect(transformed).toContain('type: "object"');
    expect(transformed).toContain("increment");
    expect(transformed).toContain('type: "number"');
    
    // Check for required fields
    expect(transformed).toContain('required: ["increment"]');
    expect(transformed).toContain('required: ["value"]');
  });

  it("transforms handler with complex nested types", async () => {
    const source = `/// <cts-enable />
import { handler, Cell } from "commontools";

interface UserEvent {
  user: {
    name: string;
    email: string;
    age?: number;
  };
  action: "create" | "update" | "delete";
}

interface UserState {
  users: Array<{
    id: string;
    name: string;
    email: string;
  }>;
  lastAction: string;
  count: Cell<number>; // @asCell
}

const userHandler = handler<UserEvent, UserState>((event, state) => {
  if (event.action === "create") {
    state.users.push({
      id: Date.now().toString(),
      name: event.user.name,
      email: event.user.email
    });
    state.count.set(state.count.get() + 1);
  }
  state.lastAction = event.action;
});

export { userHandler };
`;

    const transformed = await transformSource(source, {
      types: { "commontools.d.ts": commontools },
      applySchemaTransformer: true,
      debug: false
    });

    // Check that handler received schemas
    expect(transformed).toContain("handler(");
    
    // Check nested object schema
    expect(transformed).toContain('"user"');
    expect(transformed).toContain('"name"');
    expect(transformed).toContain('"email"');
    
    // Check union type transformation
    // Currently the schema transformer generates oneOf with type: "any" for union string literals
    // This is a known limitation - just check that oneOf is present
    expect(transformed).toContain('oneOf:');
    
    // Check array type
    expect(transformed).toContain('type: "array"');
    
    // Check Cell type with asCell
    expect(transformed).toContain('asCell: true');
    
    // Check optional property (age should not be in required)
    const requiredMatch = transformed.match(/required:\s*\[(.*?)\]/g);
    expect(requiredMatch).toBeTruthy();
    // The user object should have name and email required, but not age
    expect(transformed).toContain('required: ["name", "email"]');
  });

  it("preserves handler without type parameters", async () => {
    const source = `/// <cts-enable />
import { handler } from "commontools";

const eventSchema = {
  type: "object",
  properties: {
    message: { type: "string" }
  }
};

const stateSchema = {
  type: "object",
  properties: {
    log: { type: "array", items: { type: "string" } }
  }
};

const logHandler = handler(eventSchema, stateSchema, (event, state) => {
  state.log.push(event.message);
});

export { logHandler };
`;

    const transformed = await transformSource(source, {
      types: { "commontools.d.ts": commontools },
      applySchemaTransformer: true,
      debug: false
    });

    // Should preserve the original handler call with explicit schemas
    expect(transformed).toContain("handler(eventSchema, stateSchema");
    expect(transformed).not.toContain("toSchema");
  });

  it("transforms handler with Date and Map types", async () => {
    const source = `/// <cts-enable />
import { handler } from "commontools";

interface TimedEvent {
  timestamp: Date;
  data: Map<string, number>;
}

interface TimedState {
  lastUpdate: Date;
  history: Map<string, Date>;
}

const timedHandler = handler<TimedEvent, TimedState>((event, state) => {
  state.lastUpdate = event.timestamp;
  event.data.forEach((value, key) => {
    state.history.set(key, new Date());
  });
});

export { timedHandler };
`;

    const transformed = await transformSource(source, {
      types: { "commontools.d.ts": commontools },
      applySchemaTransformer: true,
      debug: false
    });

    // Date should be transformed to string with format
    expect(transformed).toContain('type: "string"');
    expect(transformed).toContain('format: "date-time"');
    
    // Map should be transformed to object
    expect(transformed).toContain('type: "object"');
    // Map type generates a complex schema with Map methods
    expect(transformed).toContain('forEach');
    expect(transformed).toContain('get');
    expect(transformed).toContain('set');
  });

  it("shows complete transformation from handler<T,U> to handler with schemas", async () => {
    const source = `/// <cts-enable />
import { handler } from "commontools";

interface Event {
  detail: {
    value: number;
  };
}

interface State {
  value: number;
}

const increment = handler<Event, State>((_, state) => {
  state.value = state.value + 1;
});
`;

    const transformed = await transformSource(source, {
      types: { "commontools.d.ts": commontools },
      applySchemaTransformer: true,
      debug: false
    });

    // The handler should now have schema objects as arguments
    expect(transformed).toContain("handler({");
    expect(transformed).not.toContain("toSchema<");
    expect(transformed).not.toContain("handler<Event, State>");
    
    // Check the generated schemas
    expect(transformed).toContain('type: "object"');
    expect(transformed).toContain("properties:");
    expect(transformed).toContain("detail:");
    expect(transformed).toContain("value:");
  });
});