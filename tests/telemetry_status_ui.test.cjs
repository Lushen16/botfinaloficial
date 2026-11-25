'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { telemetryStatus, renderTelemetryStatus } = require('../reconstruction/app/ui/diagnostics.js');
const session = telemetry => ({ pid: 7, ageMs: 0, telemetry });

test('status preserves unknown values, zero sequence, blind and observed empty', () => {
  assert.equal(telemetryStatus(null).age, '—');
  assert.equal(telemetryStatus(null).mode, '—');
  const blind = telemetryStatus(session({ source:'chain',seq:0,creaturesAvailable:false,itemsAvailable:false }),
    {pid:7,telemetry:{intervalMs:5000}});
  assert.equal(blind.seq,'0');
  assert.equal(blind.interval,'5 s');
  assert.equal(blind.age,'0 ms');
  assert.equal(blind.creatures,'Blind · criaturas indisponíveis');
  assert.equal(blind.items,'Indisponíveis');
  const empty = telemetryStatus(session({ creaturesAvailable:true,creatures:[],itemsAvailable:true,items:[] }));
  assert.equal(empty.blind,false);
  assert.equal(empty.creatures,'Criaturas observadas');
  assert.equal(empty.items,'Observados');
});

test('status never borrows metadata or errors from a different selected session', () => {
  const state = telemetryStatus(session({}),{pid:8,telemetry:{mode:'chain',intervalMs:2000},error:'unsupported-build'});
  assert.equal(state.mode,'—');
  assert.equal(state.interval,'—');
  assert.equal(state.buildError,'');
});

test('missing PIDs never match runtime metadata implicitly', () => {
  const state = telemetryStatus({telemetry:{}},{telemetry:{mode:'chain',intervalMs:5000},error:'unsupported-build'});
  assert.equal(state.mode,'—');
  assert.equal(state.interval,'—');
  assert.equal(state.buildError,'');
});

test('null runtime and configuration leave diagnostics readable', () => {
  const state = telemetryStatus(session({seq:1}),null,null);
  assert.equal(state.seq,'1');
  assert.equal(state.interval,'—');
});

test('structured and coded build errors are displayed without exposing the raw message', () => {
  for (const problem of [{reason:'build-unsupported'}, {blocker:{code:'build-unsupported'}},
    {error:{code:'build-unsupported',message:'private/path'}}]) {
    const state = telemetryStatus({...session({}),...problem});
    assert.match(state.buildError,/Build não suportado/u);
    assert.doesNotMatch(state.buildError,/private/u);
  }
  const state = telemetryStatus(session({}),{pid:7,reason:'build-unsupported'});
  assert.match(state.buildError,/Build não suportado/u);
});

test('status displays sampled age without treating a future timestamp as fresh', () => {
  const state = telemetryStatus({ stale:true,telemetry:{sampledAtMs:1000} },{}, {}, 6500);
  assert.equal(state.age,'5,5 s · atrasada');
  assert.equal(telemetryStatus({telemetry:{sampledAtMs:7000}},{}, {},6500).age,'—');
  assert.equal(telemetryStatus(session({seq:NaN,intervalMs:-1})).interval,'—');
});

test('renderer removes obsolete blind badge and build error as snapshots change', () => {
  const ids = ['sample-mode','sample-interval','sample-seq','sample-age','sample-creatures','sample-items','sample-build-error'];
  const elements = new Map(ids.map(id => [id,{ textContent:'',hidden:true,classList:{toggle(name,value){this[name]=value;}} }]));
  const document = {getElementById:id=>elements.get(id)};
  renderTelemetryStatus(document,{ ...session({creaturesAvailable:false}),error:'unknown executable identity: digest' });
  assert.equal(elements.get('sample-creatures').classList.blind,true);
  assert.equal(elements.get('sample-build-error').hidden,false);
  assert.match(elements.get('sample-build-error').textContent,/Build não suportado/u);
  renderTelemetryStatus(document,session({source:'native',creaturesAvailable:true}));
  assert.equal(elements.get('sample-mode').textContent,'native');
  assert.equal(elements.get('sample-creatures').classList.blind,false);
  assert.equal(elements.get('sample-build-error').hidden,true);
  assert.equal(elements.get('sample-build-error').textContent,'');
});

test('main interface wires the status renderer and provides labels for every value', () => {
  const ui = path.join(__dirname,'../reconstruction/app/ui');
  const html = fs.readFileSync(path.join(ui,'index.html'),'utf8');
  const app = fs.readFileSync(path.join(ui,'app.js'),'utf8');
  assert.match(app,/PkaDiagnostics\.renderTelemetryStatus\(document,n,runtime,config\.telemetry\)/u);
  assert.match(html,/aria-labelledby="sample-status-title"/u);
  assert.match(html,/id="sample-creatures"[^>]*role="status"/u);
  assert.match(html,/<dt>Sequência<\/dt><dd id="sample-seq">/u);
  assert.match(html,/<dt>Idade da amostra<\/dt><dd id="sample-age">/u);
});
