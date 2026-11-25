'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EngineRuntime } = require('../reconstruction/engine-runtime.cjs');

const pos = x => ({ x, y: 10, z: 7 });
const enemy = { id: 2, name: 'Wild', hp: 100, type: 1, pos: pos(11) };
const pet = { id: 3, name: 'Pet', hp: 100, type: 3, ownPokemon: true, pos: pos(12) };
const walker = { stepIntervalMs: 0, waypoints: [{ action: 'walk', pos: pos(20) }] };
const target = { monsters: ['*'], maxDistance: 4, combo: { enabled: true, sequenceText: 'm1,m2', stepDelay: 300 } };
const looting = { captureEnabled: true, maxAttemptsPerCorpse: 2, captureDelay: 500,
  captureEntries: [{ corpseId: 17, ballSlot: 1, fallbackBallKey: 'B' }] };
const body = { id: 17, pos: pos(12) };
function sample(seq, now, fields = {}, session = {}) {
  return { now, snapshot: { online: true, ...session, telemetry: { seq, player: { id: 1, pos: pos(10) },
    healthPercent: 100, creaturesAvailable: true, creatures: [], ...fields } } };
}
const names = result => result.orders.map(order => order.name);

test('emergency potion uses only measured player HP, strictly below threshold', () => {
  const config = { hoenn: { potionHpPercent:30, potionHotkey:'P', potionCooldownMs:1000 } };
  const outputs = EngineRuntime.replay(config,[100,null,30,29,10].map((hp,index)=>
    sample(index+1,index*100,{healthPercent:hp,creatures:[{...pet,hp:1}]})));
  assert.deepEqual(outputs.map(names),[[],[],[],['potion'],[]]);
});

test('two attacks with observed unchanged HP rotate on the following sample', () => {
  const config = {target:{monsters:['*'],attackCooldownMs:100,damageTimeoutMs:5000}};
  const creatures = [enemy,{...enemy,id:7,pos:pos(13)}];
  const outputs = EngineRuntime.replay(config,[0,100,200].map((now,index)=>sample(index+1,now,{creatures})));
  assert.deepEqual(outputs.map(result=>result.targetId),[2,2,7]);
  assert.ok(outputs.every(result=>!result.effectVerified));
});

test('replay attack uses a tile; an unknown HP between numeric samples is not damage', () => {
  const outputs = EngineRuntime.replay({target},[90,null,75].map((hp,index)=>
    sample(index+1,index*150,{creatures:[{...enemy,hp},pet]})));
  assert.deepEqual(outputs[0].orders[0],{name:'attack',parameter:{pos:{x:11,y:10}}});
  assert.deepEqual(outputs.map(result=>result.effectVerified),[false,false,true]);
  assert.deepEqual(outputs[2].orders,[{name:'talk',parameter:'m2'}]);
});

test('a held replay walker releases its pending step before the next movement grant', () => {
  const results = EngineRuntime.replay({walker,target},[
    sample(1,0), sample(2,100,{creatures:[enemy]}), sample(3,200)]);
  assert.deepEqual(results.map(result=>result.allowMovement),[true,false,true]);
  assert.deepEqual(results.map(names),[['walk'],['attack','talk'],['walk']]);
});

test('a late null sample cannot renew a consumed corpse attempt', () => {
  const config = {looting:{...looting,maxAttemptsPerCorpse:1}};
  const items = {itemsAvailable:true,items:[body]};
  const results = EngineRuntime.replay(config,[sample(10,0,items), sample(9,100,{player:null}),
    sample(11,600,items), sample(12,700,{player:null}), sample(13,800,items)]);
  assert.deepEqual(results.map(names),[['capture'],[],[],[],['capture']]);
});

for (const interruption of ['pause','map','null']) {
  test(interruption + ' clears the target deadline and the capture budget', () => {
    const config = {target:{monsters:['*'], attackCooldownMs:60000},looting:{...looting,maxAttemptsPerCorpse:1}};
    const combat = {creatures:[enemy]}, items = {itemsAvailable:true,items:[body]};
    const map = interruption === 'map' ? {mapId:2} : {};
    for (const [fields,order] of [[combat,'attack'],[items,'capture']]) {
      const results = EngineRuntime.replay(config,[sample(1,0,fields), sample(2,1200,fields),
        sample(3,1300,interruption === 'null' ? {player:null} : map,{paused:interruption === 'pause'}),
        sample(4,1400,{...map,...fields})]);
      assert.deepEqual(results.map(names),[[order],[],[],[order]]);
      assert.equal(results[2].allowMovement,false);
    }
  });
}

test('unsigned ID families take precedence over a contradictory wild type', () => {
  const rows = [0x80000003, 0x10000009].map(id => ({...enemy, id}));
  rows.push({...enemy,id:5,type:0}, {...enemy,id:6,type:2});
  const config = {target:{...target, monsters:[{name:'*',minCount:2,range:4}] }};
  const outcomes = EngineRuntime.replay(config, [
    sample(1,0,{creatures:rows}),
    sample(2,100,{creatures:[...rows,enemy]}),
    sample(3,200,{creatures:[...rows,enemy,{...enemy,id:7,pos:pos(13)}]}),
  ]);
  assert.deepEqual(outcomes.map(row=>row.wildCount),[0,1,2]);
  assert.deepEqual(outcomes.slice(0,2).map(names),[[],[]]);
  assert.ok([2,7].includes(outcomes[2].targetId));
});

test('unknown HP can be targeted; retry budget waits for deadline before rotation', () => {
  const creatures = [{...enemy,hp:null},{...enemy,id:7,pos:pos(13)}];
  const config = { target:{monsters:['*'],maxDistance:5,maxAttemptsPerTarget:1,attackCooldownMs:100,damageTimeoutMs:500} };
  const results = EngineRuntime.replay(config,[0,100,499,500].map((now,index)=>sample(index+1,now,{creatures})));
  assert.deepEqual(results.map(row=>row.targetId),[2,2,2,7]);
  assert.deepEqual(results.map(names),[['attack'],[],[],['attack']]);
  assert.ok(results.every(row=>row.effectVerified === false));
});

test('first measured HP sets a baseline and is not itself evidence of damage', () => {
  const inputs = [null,70,65].map((hp,index)=>sample(index+1,index*100,{creatures:[{...enemy,hp}]}));
  const results = EngineRuntime.replay({target:{monsters:['*']}},inputs);
  assert.deepEqual(results.map(row=>row.effectVerified),[false,false,true]);
});

test('a new player receives fresh target and corpse budgets; unavailable is not an empty observation', () => {
  const config = {target:{monsters:['*'],maxAttemptsPerTarget:1,attackCooldownMs:100},looting:{...looting,maxAttemptsPerCorpse:1}};
  const items = {itemsAvailable:true,items:[body]};
  const player = {id:18,pos:pos(10)};
  const outcomes = EngineRuntime.replay(config,[sample(1,0,items),sample(2,100,{...items,itemsAvailable:false}),
    sample(3,200,items),sample(4,300,{itemsAvailable:true,items:[]}),sample(5,900,items),
    sample(6,1000,{creatures:[enemy]}),sample(7,1100,{creatures:[enemy]}),
    sample(8,1200,{player,creatures:[enemy]}),sample(9,1300,{player,creatures:[enemy]}),sample(10,1400,{player,...items})]);
  assert.deepEqual(outcomes.map(names),[['capture'],[],[],[],['capture'],['attack'],[],[],['attack'],['capture']]);
});

test('walker yields to loot, combo, heal, emergency potion and pending revive', () => {
  const fight = { creatures: [enemy, pet], itemsAvailable: true, items: [body] };
  const config = { walker, looting, target: { ...target, autoRevive: { enabled: true, hotkey: 'R', interval: 250 } },
    hoenn: { potionHpPercent: 20, potionHotkey: 'P', potionCooldownMs: 5000 },
    healer: { healPokemonName: 'Pet', healHpPercent: 50, healMoveSlot: 4 } };
  const outputs = EngineRuntime.replay(config, [
    sample(1,0), sample(2,100,{ itemsAvailable:true,items:[body] }),
    sample(3,200,{ ...fight,healthPercent:10 }), sample(4,300,{ ...fight,healthPercent:30 }),
    sample(5,400,fight), sample(6,700,fight),
    sample(7,6000,{ ...fight,healthPercent:10 }), sample(7,6100,{ ...fight,healthPercent:10 }),
  ]);
  assert.deepEqual(outputs.map(names), [['walk'],['capture'],['potion'],['talk'],['attack','talk'],['talk'],['potion'],[]]);
  assert.deepEqual(outputs.slice(2,7).map(result => result.orders.at(-1).parameter), ['P','m4','m1','m2','R']);
});

test('a null frame or new player cancels combo; pause cancels a due revive', () => {
  const fight = { creatures:[enemy,pet] };
  const config = { target:{ ...target,autoRevive:{enabled:true,hotkey:'R',interval:100} } };
  for (const interrupted of [sample(2,100,{ player:null }), sample(2,100,{...fight,player:{id:55,pos:pos(10)}})]) {
    const nextPlayer = interrupted.snapshot.telemetry.player ?? {id:1,pos:pos(10)};
    const outputs = EngineRuntime.replay(config,[sample(1,0,fight),interrupted,sample(3,300,{...fight,player:nextPlayer})]);
    assert.deepEqual(names(outputs[1]),[]);
    assert.equal(outputs[2].orders.at(-1).parameter,'m1');
  }
  const outputs = EngineRuntime.replay(config,[sample(1,0,fight),sample(2,300,fight),
    sample(3,500,fight,{paused:true}),sample(3,600,fight),sample(4,700,fight)]);
  assert.deepEqual(outputs.slice(2,4).map(names),[[],[]]);
  assert.equal(outputs[4].orders.at(-1).parameter,'m1');
});

test('three distinct missing samples trigger one disconnect; recovery rearms', () => {
  const config = { alerts:{rules:[{name:'off',type:'disconnected',enabled:true}]} };
  const lost = seq => sample(seq,seq*5000,{player:null},{online:false});
  const outputs = EngineRuntime.replay(config,[sample(1,0),lost(2),lost(2),sample(3,15000),lost(4),lost(5),lost(6),lost(7)]);
  assert.deepEqual(outputs.map(result=>result.monitor.actions.length),[0,0,0,0,0,0,1,0]);
});

test('unavailable item samples cannot consume a retry or create a capture', () => {
  const loot = items => ({itemsAvailable:true,items});
  const other = { ...body,pos:pos(13) };
  const outputs = EngineRuntime.replay({walker,looting},[sample(1,0,{itemsAvailable:false,items:[body]}),
    sample(2,100,loot([body])),sample(3,200,loot([body,other])),sample(4,599,loot([body])),
    sample(5,600,loot([body])),sample(6,700,loot([body]))]);
  assert.deepEqual(outputs.map(names),[['walk'],['capture'],['capture'],[],['capture'],['walk']]);
  assert.deepEqual(outputs[4].orders[0].parameter,{x:12,y:10,ball:'B'});
});

test('blind transition holds walker once; outside-combat healer requires observed absence', () => {
  const config = {walker,target,healer:{onlyOutsideCombat:true,healHpPercent:50,healPokemonName:'Pet',healMoveSlot:4}};
  const blind = { creaturesAvailable:false,creatures:[enemy,pet],healthPercent:20 };
  const outputs = EngineRuntime.replay(config,[sample(1,0,{creatures:[enemy,pet],healthPercent:20}),
    sample(2,100,blind),sample(3,200,blind),sample(4,400,{creatures:[pet],healthPercent:20})]);
  assert.equal(outputs[0].orders.at(-1).parameter,'m1');
  assert.deepEqual(outputs.slice(1,3).map(result=>[result.wildCount,names(result)]),[[null,[]],[null,['walk']]]);
  assert.equal(outputs[3].orders.at(-1).parameter,'m4');
});
