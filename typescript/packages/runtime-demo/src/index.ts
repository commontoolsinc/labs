import { demo as demoOne } from './demo1.js';
import { demo as demoTwo } from './demo2.js';
import { demo as demoThree } from './demo3.js';
import { demo as demoFour } from './demo4.js';

(self as any).demoOne = demoOne;
(self as any).demoTwo = demoTwo;
(self as any).demoThree = demoThree;
(self as any).demoFour = demoFour;
