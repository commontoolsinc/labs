import { assert, equals, throws } from './assert.js';
import { state } from '@commontools/common-frp/signal';
import { tags, signal, render } from '../lib/hyperscript.js';

const { hstack } = tags;

describe('vnode factory functions', () => {
  it('creates a vnode', () => {
    const vnode = hstack(
      {'className': 'foo'},
      'Hello'
    );
  
    equals(vnode.tag, 'com-hstack');
    equals(vnode.props.className, 'foo');
    equals(vnode.children[0], 'Hello');
  });
});

describe("it does not create tags that aren't whitelisted", (_) => {
  throws(() => {
    tags.div(
      {'className': 'foo'},
      'Hello'
    );
  });
});

describe("it binds signals", (_) => {
  const className = state('foo');
  const vnode = hstack(
    {'className': signal('string', 'className')},
    'Hello'
  );
  const element = render(vnode, {className});
});