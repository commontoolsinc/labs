import test from 'node:test'
import { deepEqual } from 'node:assert/strict'
import { tags } from '../hyperscript.js'

const { hstack } = tags;

test('test', (_) => {
  const vnode = hstack(
    {'className': 'foo'},
    'Hello'
  );

  deepEqual(vnode, {
    tag: 'com-hstack',
    props: {'className': 'foo'},
    children: ['Hello']
  })
});