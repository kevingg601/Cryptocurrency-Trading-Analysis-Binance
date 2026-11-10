const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

function fixture(packaged = false) {
  const events = new Map();
  const timers = new Map();
  const exits = [];
  let nextTimer = 0;
  let child;
  const app = { isPackaged: packaged, on: (name, fn) => events.set(name, fn),
    whenReady: () => ({ then() {} }), exit: code => exits.push(code) };
  const electron = { app, utilityProcess: { fork: (entry, args, options) => {
    child = new EventEmitter();
    child.entry = entry;
    child.options = options;
    child.postMessage = message => { child.lastMessage = message; };
    child.kill = () => { child.killed = true; child.emit('exit', 1); };
    return child;
  } } };
  const context = vm.createContext({
    require: name => name === 'electron' ? electron : require(name),
    __dirname: path.resolve(__dirname, '..'), process: { env: {}, resourcesPath: 'X:/fake/resources', platform: 'win32', stdout: { write() {} }, stderr: { write() {} } },
    console: { log() {}, warn() {}, error() {} }, URLSearchParams,
    setTimeout: fn => { const id = ++nextTimer; timers.set(id, fn); return id; },
    clearTimeout: id => timers.delete(id), module: { exports: {} },
  });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '..', 'main.cjs'), 'utf8') + '\nmodule.exports = { startCollector };', context);
  return { start: () => context.module.exports.startCollector('secret', 'unused-test-path'), events, timers, exits, get child() { return child; } };
}

test('packaged desktop starts the compiled collector outside ASAR without TypeScript stripping', async () => {
  const state = fixture(true);
  const starting = state.start();
  assert.ok(state.child.entry.includes('app.asar.unpacked'));
  assert.ok(state.child.entry.endsWith(path.join('apps', 'collector', 'src', 'main.js')));
  assert.equal(state.child.options.execArgv.length, 0);
  state.child.emit('message', { type: 'ready', port: 1234 });
  assert.equal(await starting, 1234);
});

test('desktop rejects a collector exit before readiness and clears its timeout', async () => {
  const state = fixture();
  const starting = state.start();
  state.child.emit('exit', 1);
  await assert.rejects(starting, /before readiness/);
  assert.equal(state.timers.size, 0);
});

test('desktop startup timeout kills the child instead of leaving a collector behind', async () => {
  const state = fixture();
  const starting = state.start();
  [...state.timers.values()][0]();
  await assert.rejects(starting);
  assert.equal(state.child.killed, true);
});

test('desktop prevents repeated quit requests and waits for collector process exit after flush acknowledgement', async () => {
  const state = fixture();
  const starting = state.start();
  state.child.emit('message', { type: 'ready', port: 1234 });
  assert.equal(await starting, 1234);
  let prevented = 0;
  const event = { preventDefault: () => prevented++ };
  await state.events.get('before-quit')(event);
  await state.events.get('before-quit')(event);
  assert.equal(prevented, 2);
  assert.equal(state.child.lastMessage.type, 'shutdown');
  state.child.emit('message', { type: 'flushed' });
  assert.deepEqual(state.exits, []);
  state.child.emit('exit', 0);
  assert.deepEqual(state.exits, [0]);
  assert.equal(state.timers.size, 0);
});
