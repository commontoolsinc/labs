import {
  assertEquals,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import * as stream from '../stream.js';

Deno.test('subject', async () => {
  const s = stream.subject<number>();
  const values: number[] = [];
  stream.sink(() => {
    
  })
  s.(v => values.push(v));
  s.next(1);
  s.next(2);
  s.next(3);
  assertEquals(values, [1, 2, 3]);
})