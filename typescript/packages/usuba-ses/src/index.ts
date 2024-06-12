/// <reference types="ses" />
import 'ses';
import { CompartmentAlias } from './ses.js';

export const Compartment = CompartmentAlias;
export const lockdown = globalThis.lockdown;

export { StaticModuleRecord } from '@endo/static-module-record';
