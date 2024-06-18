import { RuntimeContext } from '../index.js';
import { RuntimeRemoteWorker } from './runtime.js';

console.log('O HAI REMOTE WORKER HERE');
(self as any).runtimeContext = new RuntimeContext(new RuntimeRemoteWorker());
