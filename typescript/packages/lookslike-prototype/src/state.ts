import { get, set, del, keys } from 'idb-keyval';
import { SignalSubject } from '../../common-frp/lib/signal.js';

// Helper function for serialization boundary (this can be customized as needed)
const serializationBoundary = (data: any) => {
  return JSON.stringify(data);
};

export async function listKeys() {
  return await keys();
}

export type Context<T> = {
  inputs: { [node: string]: { [input: string]: T } },
  outputs: { [node: string]: T },
}

export function snapshot(ctx: Context<SignalSubject<any>>) {
  const snapshot: Context<any> = {
    inputs: {},
    outputs: {}
  }

  for (const key in ctx.outputs) {
    const value = ctx.outputs[key].get()
    snapshot.outputs[key] = value
  }

  for (const key in ctx.inputs) {
    snapshot.inputs[key] = {}
    for (const inputKey in ctx.inputs[key]) {
      const value = ctx.inputs[key][inputKey].get()
      snapshot.inputs[key][inputKey] = value
    }
  }

  return snapshot
}

// System object that interacts with IndexedDB
export const system = {
  get: async (key: string) => {
    const data = await get(key);
    if (data) {
      return data;
    }

    // Fallback to hardcoded data if nothing is found in IndexedDB
    if (key === 'todos') {
      const todos = [
        { label: 'Buy groceries', checked: false },
        { label: 'Vacuum house', checked: true },
        { label: 'Learn RxJS', checked: false }
      ];
      await set(key, todos);
      return serializationBoundary(todos);
    }

    if (key === 'emails') {
      const emails = [
        { subject: 'Meeting', from: 'John', date: '2020-01-01', read: false },
        { subject: 'Lunch', from: 'Jane', date: '2020-01-02', read: true },
        { subject: 'Dinner', from: 'Joe', date: '2020-01-03', read: false }
      ];
      await set(key, emails);
      return serializationBoundary(emails);
    }

    return [];
  },

  set: async (key: string, value: any) => {
    await set(key, value);
  },

  delete: async (key: string) => {
    await del(key);
  }
};
