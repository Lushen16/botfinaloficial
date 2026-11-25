'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFrameAutomation } = require('../reconstruction/automation.cjs');
const pos = (x, y = 10) => ({ x, y, z: 7 });
const enemy = (id, hp = 100) => ({ id, hp, type: 1, name: 'Wild', pos: pos(10 + id) });
const pet = { id: 8, hp: 80, type: 3, ownPokemon: true, name: 'Pet', pos: pos(10) };
const snapshot = (seq, overrides = {}) => ({ online: true, telemetry: { seq, player: { id: 9, name: 'Demo', pos: pos(10) },
  healthPercent: 100, creaturesAvailable: true, creatures: [enemy(1), pet], ...overrides } });
const options = { monsters: ['*'], maxDistance: 4, combo: { enabled: true, sequenceText: 'm1,m2', stepDelay: 300 } };
const talks = result => result.orders.filter(order => order.name === 'talk').map(order => order.parameter);

test('ordered skills and delayed revive wait for a positive observation of the active Pokemon', () => {
  const engine = createFrameAutomation({ target: { ...options, autoRevive: { enabled: true, hotkey: 'F', interval: 500, waitForPokemon: true } } });
  assert.deepEqual(talks(engine.tick(snapshot(1), 0)), ['m1']);
  assert.deepEqual(talks(engine.tick(snapshot(2), 299)), []);
  assert.deepEqual(talks(engine.tick(snapshot(3), 300)), ['m2']);
  assert.equal(engine.tick(snapshot(4), 799).phase, 'revive-delay');
  assert.deepEqual(engine.tick(snapshot(5), 800).orders, [{ name: 'potion', parameter: 'F' }]);
  assert.equal(engine.tick(snapshot(6, { creatures: [enemy(1)] }), 801).phase, 'await-pokemon');
  assert.equal(engine.tick(snapshot(7), 900).pokemonObserved, true);
});

test('damage requires lower HP; unchanged HP rotates to a different coordinate', () => {
  const engine = createFrameAutomation({ target: { monsters: ['*'], maxDistance: 5, damageTimeoutMs: 400 } });
  const step = (seq, hp) => engine.tick(snapshot(seq, { creatures: [enemy(1,hp),enemy(2)] }), (seq-1)*500);
  assert.deepEqual(step(1,100).orders[0], { name: 'attack', parameter: { x: 11, y: 10 } });
  assert.equal(step(2,100).targetId, 2);
  assert.equal(engine.state.target.effectVerified, false);
  assert.equal(engine.tick(snapshot(3,{ creatures:[enemy(2,70)] }), 600).effectVerified, true);
});

test('pause, provider loss, map change and entity change cancel pending skills', () => {
  for (const interrupt of [{ ...snapshot(2), paused: true }, null, snapshot(2,{ mapId: 2 }),
    snapshot(2,{ player: { id: 20, pos: pos(10) } })]) {
    const engine = createFrameAutomation({ target: options });
    assert.deepEqual(talks(engine.tick(snapshot(1), 0)), ['m1']);
    assert.deepEqual(engine.tick(interrupt, 300).orders, []);
    engine.tick(snapshot(3), 600);
    assert.ok(engine.state.target.comboIndex <= 1);
  }
});

test('emergency potion respects cooldown; blind never interprets residual targets', () => {
  const engine = createFrameAutomation({ hoenn: { potionHpPercent: 30, potionHotkey: 'P', potionCooldownMs: 1000 } });
  const step = (seq, now) => engine.tick(snapshot(seq,{ healthPercent: 20, creaturesAvailable:false }),now);
  assert.equal(step(1,0).orders[0].parameter,'P');
  assert.equal(step(2,500).wildCount,null);
  assert.deepEqual(step(3,999).orders,[]);
  assert.equal(step(4,1000).phase,'emergency-potion');
});

test('corpse id, fallback, per-body retry limit and walker hold', () => {
  const engine = createFrameAutomation({ looting: { captureEnabled:true, captureAfterCombat:true, captureDelay:500,
    maxAttemptsPerCorpse:2, captureEntries:[{ corpseId:20, ballSlot:1, fallbackBallKey:'B' }] } });
  const step = (seq,now) => engine.tick(snapshot(seq,{ creatures:[], itemsAvailable:true, items:[{ id:20, pos:pos(12), stack:0 }] }),now);
  assert.equal(step(1,0).orders[0].parameter.ballSlot,1);
  assert.equal(step(2,499).pauseWalker,true);
  assert.equal(step(3,500).orders[0].parameter.ballKey,'B');
  assert.equal(step(4,1000).pauseWalker,false);
});

test('observed empty waits for combat end; blacked-out frames cannot trigger after-combat capture', () => {
  const engine = createFrameAutomation({ target:{ ...options,endCombatDelayMs:500 } });
  engine.tick(snapshot(1),0);
  assert.equal(engine.tick(snapshot(2,{ creatures:[] }),100).phase,'await-combat-end');
  assert.equal(engine.tick(snapshot(3,{ creatures:[] }),600).phase,'walker');
  assert.equal(engine.tick(snapshot(4,{ creaturesAvailable:false }),650).phase,'blind');
});

test('force box issues a waypoint decision without estimating player movement', () => {
  const box = { action:'box',pos:pos(13) };
  const engine = createFrameAutomation({ walker:{waypoints:[box]}, hoenn:{forceBox:true,minWildsToEngage:1}, target:options });
  assert.deepEqual(engine.tick(snapshot(1),0).waypoint,box);
  assert.deepEqual(engine.tick(snapshot(2),9999).waypoint,box);
  assert.deepEqual(talks(engine.tick(snapshot(3,{player:{id:9,pos:pos(13)}}),10000)),['m1']);
});

test('exported alert state distinguishes missing perception from disappearance', () => {
  const engine = createFrameAutomation({alerts:{rules:[{name:'wild',type:'creature',creatureName:'Wild',enabled:true,creatureRange:3},
    {name:'off',type:'disconnected',enabled:true}]}});
  assert.equal(engine.tick(snapshot(1),0).monitor.actions[0].ruleId,'wild');
  engine.tick(snapshot(2,{creaturesAvailable:false}),100);
  assert.equal(engine.tick(snapshot(3),200).monitor.actions.length,0);
  assert.deepEqual(engine.tick(null,300).monitor.actions,[]);
  assert.deepEqual(engine.tick({online:false},301).monitor.actions,[]);
  assert.equal(engine.tick({online:false},302).monitor.actions[0].ruleId,'off');
  assert.equal(engine.state.alerts.find(rule=>rule.ruleId==='off').phase,'suppressed');
});

test('literal autocombo, range and finishRemaining release', () => {
  const engine = createFrameAutomation({ target: { ...options, combo: { enabled:true, sequenceText:'!autocombo', finishRemainingCount:1 } } });
  assert.deepEqual(talks(engine.tick(snapshot(1,{creatures:[enemy(9)]}),0)),[]);
  assert.deepEqual(talks(engine.tick(snapshot(2,{creatures:[enemy(1),enemy(2),pet]}),300)),['!autocombo']);
  assert.equal(engine.tick(snapshot(3),600).phase,'walker');
  assert.equal(engine.tick(snapshot(4),900).pauseWalker,false);
});

test('observed heal, reset, and return are distinct orders', () => {
  const engine = createFrameAutomation({ healer:{healPokemonName:'Pet',healHpPercent:40,healMoveSlot:2,
    healResetSlot:4,returnPokemonName:'Other'} });
  const step = (seq,hp) => engine.tick(snapshot(seq,{healthPercent:hp,creatures:[pet],
    roster:[{name:'Pet',slot:1,uuid:'pet'},{name:'Other',slot:2,uuid:'other'}],activeSlot:1}),seq*1000);
  assert.deepEqual(talks(step(1,30)),['m2']);
  assert.deepEqual(talks(step(2,90)),['m4']);
  assert.deepEqual(step(3,90).orders,[{name:'switchPokemon',parameter:'Other'}]);
});

test('fresh chat and HP edges respect configured cooldown, independently', () => {
  const engine = createFrameAutomation({alerts:{rules:[
    {name:'chat',type:'chat',enabled:true,cooldownMs:1000},
    {name:'hp',type:'hp',enabled:true,hpThreshold:30,hpOnce:true,cooldownMs:1000},
  ]}});
  const step = (seq,now,hp) => engine.tick(snapshot(seq,{healthPercent:hp,alertEvents:[{id:seq,kind:'talk'}]}),now)
    .monitor.actions.map(action=>action.ruleId);
  assert.deepEqual(step(1,0,20),['chat','hp']);
  assert.deepEqual(step(2,100,80),[]);
  assert.deepEqual(step(3,200,20),[]);
  assert.deepEqual(step(4,1100,80),['chat']);
  assert.deepEqual(step(5,1200,20),['hp']);
});
