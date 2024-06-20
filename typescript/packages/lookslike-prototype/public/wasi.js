import * as cli from '/wasi-shim/cli.js';
import * as clocks from '/wasi-shim/clocks.js';
import * as filesystem from '/wasi-shim/filesystem.js';
import * as http from '/wasi-shim/http.js';
import * as io from '/wasi-shim/io.js';
import * as random from '/wasi-shim/random.js';
import * as sockets from '/wasi-shim/sockets.js';

export const shim = {
  '/wasi-shim/cli.js': Promise.resolve(cli),
  '/wasi-shim/clocks.js': Promise.resolve(clocks),
  '/wasi-shim/filesystem.js': Promise.resolve(filesystem),
  '/wasi-shim/http.js': Promise.resolve(http),
  '/wasi-shim/io.js': Promise.resolve(io),
  '/wasi-shim/random.js': Promise.resolve(random),
  '/wasi-shim/sockets.js': Promise.resolve(sockets),
};