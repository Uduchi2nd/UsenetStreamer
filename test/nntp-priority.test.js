const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const tick = () => new Promise(resolve => setImmediate(resolve));

function loadPool() {
  const clients = [];
  let alive = 0, maximum = 0, holdReady = false;
  class FakeNNTP extends EventEmitter {
    connect() {
      clients.push(this); maximum = Math.max(maximum, ++alive);
      this._socket = new EventEmitter();
      this._socket.destroy = () => {
        if (!this._socket.destroyed) { this._socket.destroyed = true; alive--; }
        setImmediate(() => this.emit('close'));
      };
      if (!holdReady) setImmediate(() => this.emit('ready'));
    }
    end() { this._socket.destroy(); }
  }
  const filename = require.resolve('../src/services/triage/index');
  const original = Module._load;
  Module._load = function(request, parent, ...args) {
    if (parent?.filename === filename && request === 'nntp/lib/nntp') return FakeNNTP;
    return original.call(this, request, parent, ...args);
  };
  const loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  try {
    loaded._compile(fs.readFileSync(filename, 'utf8') + '\nmodule.exports.testCreatePool = createNntpPool;\n', filename);
  } finally { Module._load = original; }
  return { create: () => loaded.exports.testCreatePool({ host: 'test.invalid' }, 2), clients,
    count: () => alive, maximum: () => maximum, hold: () => { holdReady = true; } };
}

test('archive/header reads overtake queued scans while preserving FIFO within each priority', async () => {
  const fixture = loadPool(), pool = await fixture.create();
  const one = await pool.acquire(), two = await pool.acquire();
  const sample1 = pool.acquire({ priority: 'sample' });
  const sample2 = pool.acquire({ priority: 'sample' });
  const header1 = pool.acquire(), header2 = pool.acquire();
  const order = [];
  header1.then(() => order.push('header1')); header2.then(() => order.push('header2'));
  sample1.then(() => order.push('sample1')); sample2.then(() => order.push('sample2'));
  pool.release(one); const h1 = await header1;
  pool.release(two); const h2 = await header2;
  pool.release(h1); const s1 = await sample1;
  pool.release(h2); const s2 = await sample2;
  assert.deepEqual(order, ['header1', 'header2', 'sample1', 'sample2']);
  assert.equal(fixture.maximum(), 2);
  pool.release(s1); pool.release(s2); await pool.close();
  assert.equal(fixture.count(), 0);
});

test('replacement connections also finish a queued header before starting another sample', async () => {
  const fixture = loadPool(), pool = await fixture.create();
  const dropped = await pool.acquire(), held = await pool.acquire();
  const sample = pool.acquire({ priority: 'sample' });
  const header = pool.acquire();
  const order = [];
  sample.then(() => order.push('sample')); header.then(() => order.push('header'));
  pool.release(dropped, { drop: true });
  const next = await header;
  assert.notEqual(next, dropped);
  assert.deepEqual(order, ['header']);
  pool.release(next); const last = await sample;
  assert.equal(fixture.maximum(), 2);
  pool.release(last); pool.release(held); await pool.close();
});

test('closing resolves both kinds of queued request and clears their acquisition timers', async () => {
  const fixture = loadPool(), pool = await fixture.create();
  await pool.acquire(); await pool.acquire();
  const sample = pool.acquire({ priority: 'sample' }), header = pool.acquire();
  await pool.close();
  assert.equal(await sample, null); assert.equal(await header, null);
  assert.equal(fixture.count(), 0);
});

test('a replacement that connects after pool shutdown is closed rather than leaked', async () => {
  const fixture = loadPool(), pool = await fixture.create();
  const dropped = await pool.acquire();
  fixture.hold();
  pool.release(dropped, { drop: true });
  await tick(); await tick();
  assert.equal(fixture.clients.length, 3);
  await pool.close();
  fixture.clients[2].emit('ready');
  await tick(); await tick();
  assert.equal(fixture.count(), 0);
  assert.equal(pool.getIdleCount(), 0);
  assert.equal(fixture.maximum(), 2);
});
