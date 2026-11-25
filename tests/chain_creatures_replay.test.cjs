'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createChainProvider } = require('../reconstruction/telemetry/chain-provider.cjs');
const { openChainAdapter } = require('../reconstruction/telemetry/chain-adapter.cjs');

test('replay distinguishes unavailable, observed and empty creature lists', async (t) => {
  const creature = { id: 7, healthPercent: 90 };
  const frames = [
    { creatures: [creature] },
    { creaturesAvailable: true, creatures: [creature] },
    { creaturesAvailable: true, creatures: [] },
    { creaturesAvailable: true },
    { creaturesAvailable: false, creatures: [creature] },
  ];
  const provider = createChainProvider({ frames });
  const adapter = await openChainAdapter({ provider, sink: {} });
  t.after(() => adapter.close());
  const read = () => adapter.getSnapshot().telemetry;
  assert.equal(read().creaturesAvailable, false);
  for (const [available, expected] of [[false, []], [true, [creature]], [true, []], [false, []], [false, []]]) {
    assert.equal(provider.next(), true);
    const snapshot = read();
    assert.equal(snapshot.creaturesAvailable, available);
    assert.deepEqual(snapshot.creatures, expected);
    if (snapshot.creatures.length) {
      snapshot.creatures[0].healthPercent = 0;
      assert.equal(read().creatures[0].healthPercent, 90);
    }
  }
});
