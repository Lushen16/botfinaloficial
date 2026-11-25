'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  EXECUTABLE_SHA256, SUPPORTED_EXECUTABLE_SHA256, isSupportedExecutable, layoutFor,
} = require('../reconstruction/executable-profile.cjs');
const { mergeItemSnapshot, LAYOUT_ID } = require('../reconstruction/item-source.cjs');

const OLD = '473df25c1edd23e7464ad3ba9b923a603051a8b4ae8004a95c06402f678294e6';
const NEW = '82eadedcba74e368a7b981a11a6a4d20546b490be6bd4565026c2de847554e1c';

function scanFor(sha256) {
  const player = { id: 0x10000001, name: 'Nobutdopai', pos: { x: 957, y: 1406, z: 6 },
    creatureType: 0, ownershipVerified: true, struct_va: '0x200' };
  return {
    schemaVersion: 1, pid: 25876, generatedAt: new Date(1000).toISOString(),
    processStartedAt: 'session-one', moduleBase: '0x140000000',
    executableSha256: sha256, layoutId: LAYOUT_ID,
    complete: true, truncated: false, readErrors: [],
    player,
    itemIdentityProfile: { executableSha256: sha256, layoutId: LAYOUT_ID },
    items: [{ id: 4029, stack: 2, pos: { x: 958, y: 1406, z: 6 },
      struct_va: '0x400', tile_va: '0x500' }],
  };
}

function session() {
  return {
    pid: 25876,
    telemetry: {
      playerName: 'Nobutdopai', position: { x: 957, y: 1406, z: 6 },
      creatures: [], items: [],
    },
  };
}

test('both known builds are supported', () => {
  assert.equal(EXECUTABLE_SHA256, OLD);
  assert.ok(isSupportedExecutable(OLD));
  assert.ok(isSupportedExecutable(NEW));
  assert.ok(SUPPORTED_EXECUTABLE_SHA256.includes(NEW));
});

test('lookup is case-insensitive and rejects unknown builds', () => {
  assert.ok(isSupportedExecutable(NEW.toUpperCase()));
  assert.equal(isSupportedExecutable('deadbeef'), false);
  assert.equal(isSupportedExecutable(null), false);
  assert.equal(isSupportedExecutable(undefined), false);
  assert.equal(isSupportedExecutable(''), false);
});

test('each supported build declares its layout and typeOffset matches', () => {
  const expected = new Map([
    [OLD, ['build-2026-10', '0x186']],
    [NEW, ['build-2026-11-03', '0x186']],
    ['0ec61b0e401396660988943701c0417e7fce87d46a32f0dd641e7c0cf9b1f29e', ['build-2026-11-20', '0x176']],
    ['14cad59648656a8f128d1582d9ad7e358a8f421798ccc26ee611ed52cc935ed8', ['build-2026-11-22', '0x176']],
    ['ed2560a00801b26796d8d666cf46d503a0c25c56075338e9102baef0d2f9c986', ['build-2026-11-23', '0x176']],
  ]);
  assert.deepEqual(new Set(SUPPORTED_EXECUTABLE_SHA256), new Set(expected.keys()));
  for (const sha of SUPPORTED_EXECUTABLE_SHA256) {
    const layout = layoutFor(sha);
    assert.ok(layout, 'layout ausente para ' + sha);
    assert.deepEqual([layout.label, layout.typeOffset], expected.get(sha));
  }
  assert.equal(layoutFor('deadbeef'), null);
});

test('item snapshot from the new build is accepted', () => {
  const merged = mergeItemSnapshot(session(), scanFor(NEW), 1100, 500);
  assert.equal(merged.telemetry.captureVersion, 1);
  assert.equal(merged.telemetry.itemPid, 25876);
  assert.equal(merged.telemetry.itemIdentityProfile.executableSha256, NEW);
  assert.equal(merged.telemetry.items.length, 1);
});

test('item snapshot from the old build still works', () => {
  const merged = mergeItemSnapshot(session(), scanFor(OLD), 1100, 500);
  assert.equal(merged.telemetry.itemIdentityProfile.executableSha256, OLD);
});

test('an unknown build is rejected instead of read blindly', () => {
  assert.throws(() => mergeItemSnapshot(session(), scanFor('deadbeef'), 1100, 500),
    /invalido|parcial|expirado|outro processo/iu);
});

test('a mismatched layout id is rejected even on a supported build', () => {
  const scan = scanFor(NEW);
  scan.layoutId = 'pka-item-unknown';
  assert.throws(() => mergeItemSnapshot(session(), scan, 1100, 500), /invalido|expirado|outro processo/iu);
});
