'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFrameAutomation } = require('../reconstruction/automation.cjs');
const { createWalkerEngine } = require('../reconstruction/engines/walker-engine.cjs');
const pos = x => ({ x,y:100,z:7 });
const enemy = { id:2,name:'Wild',type:1,hp:100,pos:pos(101) };
const frame = (seq,fields = {},session = {}) => ({ online:true,...session,
  telemetry:{seq,player:{id:1,name:'Demo',pos:pos(100)},healthPercent:100,
    creaturesAvailable:true,creatures:[],...fields} });

function fixture(config = {}, outcomes = []) {
  const engine = createFrameAutomation(config);
  const walker = createWalkerEngine(config);
  let snapshot;
  let skips = 0;
  const calls = [];
  const adapter = {
    getSnapshot: () => structuredClone(snapshot),
    async command(name,parameter) {
      const outcome = outcomes[calls.length];
      calls.push({name,parameter});
      if (outcome === 'throw') throw Error('Falha simulada');
      return outcome === false ? {accepted:false} : {accepted:true};
    },
  };
  async function tick(value,now) {
    snapshot = value;
    const current = adapter.getSnapshot();
    const decision = engine.tick(current,now);
    if (decision.pauseWalker) {
      if (decision.phase !== 'await-frame') { skips++; walker.notifySkipped(); }
    } else {
      decision.walk = walker.step({...current.telemetry,position:current.telemetry.player.pos,
        playerId:current.telemetry.player.id,tick:current.telemetry.seq},
      {command(name,parameter) {decision.orders.push({name,parameter});}},now);
    }
    const faults = [];
    for (const order of decision.orders) {
      const parameter = order.name === 'attack' ? {pos:order.parameter} : order.parameter;
      try {
        const result = await adapter.command(order.name,parameter);
        if (result.accepted !== true) faults.push({name:order.name,error:'Recusado pelo adaptador falso'});
      } catch (error) { faults.push({name:order.name,error:error.message}); }
    }
    return {...decision,faults};
  }
  return { tick,calls,get skips(){return skips;},get state(){return engine.state;} };
}

const config = {
  walker:{stepIntervalMs:0,waypoints:[{action:'walk',pos:pos(110)}]},
  target:{monsters:['*'],combo:{enabled:true,sequenceText:'m1,m2',stepDelay:300}},
};

test('real frame engine emits into an in-memory adapter; failed delivery does not stop later orders', async () => {
  const harness = fixture(config,['throw',false,true]);
  const first = await harness.tick(frame(1,{creatures:[enemy]}),0);
  assert.deepEqual(harness.calls,[{name:'attack',parameter:{pos:{x:101,y:100}}},{name:'talk',parameter:'m1'}]);
  assert.deepEqual(first.faults.map(fault=>fault.name),['attack','talk']);
  assert.equal(harness.state.target.effectVerified,false);
  const next = await harness.tick(frame(2,{creatures:[enemy]}),300);
  assert.deepEqual(next.faults,[]);
  assert.equal(harness.calls.at(-1).parameter,'m2');
});

test('pending movement is skipped for combat and resumes only on a new observed sample', async () => {
  const harness = fixture(config);
  await harness.tick(frame(1),0);
  await harness.tick(frame(2,{creatures:[enemy]}),100);
  assert.equal(harness.skips,1);
  await harness.tick(frame(2),200);
  assert.equal(harness.calls.filter(call=>call.name==='walk').length,1);
  const resumed = await harness.tick(frame(3),300);
  assert.equal(resumed.walk.action,'move');
  assert.equal(harness.calls.filter(call=>call.name==='walk').length,2);
});

test('pause cancels a due revive and the repeated sample cannot queue it again', async () => {
  const harness = fixture({...config,target:{...config.target,autoRevive:{enabled:true,hotkey:'R',interval:100}}});
  await harness.tick(frame(1,{creatures:[enemy]}),0);
  await harness.tick(frame(2,{creatures:[enemy]}),300);
  assert.equal(harness.state.revive.due,400);
  await harness.tick(frame(3,{creatures:[enemy]},{paused:true}),500);
  assert.equal(harness.state.revive,null);
  await harness.tick(frame(3,{creatures:[enemy]}),600);
  assert.equal(harness.calls.some(call=>call.name==='potion'),false);
});

test('disconnection alerts require three distinct missing samples and export suppressed state', async () => {
  const harness = fixture({alerts:{rules:[{name:'off',type:'disconnected',enabled:true}]}});
  await harness.tick(frame(1),0);
  const first = await harness.tick(frame(2,{player:null}),5000);
  assert.deepEqual(first.monitor.actions,[]);
  await harness.tick(frame(2,{player:null}),6000);
  assert.deepEqual((await harness.tick(frame(3,{player:null}),10000)).monitor.actions,[]);
  const third = await harness.tick(frame(4,{player:null}),15000);
  assert.deepEqual(third.monitor.actions,[{action:'notify',ruleId:'off',type:'disconnected'}]);
  assert.equal(harness.state.alerts[0].phase,'suppressed');
  assert.deepEqual(harness.calls,[]);
});
