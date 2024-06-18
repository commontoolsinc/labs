// @ts-ignore
import { read } from 'common:io/state@0.0.1';

export class Body {
  run() {
    console.log('Running!');

    const foo = read('foo');

    console.log('Reference:', foo);

    const value = foo?.deref();

    console.log('Value:', value);
  }
}

export const create = () => {
  console.log('Creating!');
  // return new Body();
};
