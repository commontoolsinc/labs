import { RuntimeContext } from '../index.js';
import { RuntimeSESWorker } from './runtime.js';

console.log('O HAI SES WORKER HERE');
(self as any).runtimeContext = new RuntimeContext(new RuntimeSESWorker());
