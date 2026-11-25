'use strict';
const { createChainProvider } = require('./chain-provider.cjs');
const { createInputSink } = require('./input-sink.cjs');
const { createPathPlanner } = require('../pathfinder.cjs');
const { STUCK_LIMIT } = require('../engines/walker-engine.cjs');

function createWalkerReplay({ frames, file, route, map = { tile: () => null }, outcomes, pid }) {
  const provider = createChainProvider({ frames, file });
  const sink = createInputSink({ outcomes, now: () => frame.sampledAtMs });
  const planner = createPathPlanner({ getMap: () => map, cardinalOnly: true });
  const state = { phase: 'idle', index: 0, paused: false, blind: true, creaturesAvailable: false, effectVerified: false };
  const events = [];
  let frame, lastSeq = -Infinity, playerId, halted = false, lastOrigin, attempts = 0;
  function transition(phase, reason) {
    state.phase = phase;
    events.push({ seq: lastSeq, phase, reason });
  }
  provider.start(value => {
    if (value?.pid !== pid || !Number.isSafeInteger(value.seq) || value.seq <= lastSeq) return;
    lastSeq = value.seq; frame = state.paused ? null : value;
    if (!halted && Number.isInteger(value.player?.id)) {
      if (playerId !== undefined && value.player.id !== playerId) {
        halted = true; transition('aborted', 'player-changed');
      }
      playerId = value.player.id;
    }
  });
  function tick() {
    if (halted || !frame) return;
    const player = frame.player, pos = player?.pos;
    try {
      if (!Number.isInteger(player?.id) || !pos || ![pos.x,pos.y,pos.z].every(Number.isInteger)) return;
      if (state.phase === 'dispatched') transition('confirmed', 'new-sample');
      let goal = route[state.index];
      if (!goal) return;
      if (pos.x === goal.x && pos.y === goal.y && pos.z === goal.z) {
        goal = route[++state.index]; attempts = 0;
        if (!goal) return;
      }
      const direction = planner.plan(pos, goal)?.direction;
      if (!Number.isInteger(direction)) { transition('aborted', 'no-path'); return; }
      if (!lastOrigin || pos.x !== lastOrigin.x || pos.y !== lastOrigin.y || pos.z !== lastOrigin.z) attempts = 0;
      if (attempts >= STUCK_LIMIT) { halted = true; transition('aborted', 'stuck'); return; }
      lastOrigin = { ...pos }; attempts++;
      if (!sink.step(direction).accepted) { transition('aborted', 'rejected'); return; }
      transition('dispatched', 'accepted');
    } finally { frame = null; }
  }
  return { provider, calls: sink.calls, state, events, tick, pause() {
    state.paused = true;
    frame = null;
    if (state.phase === 'dispatched') transition('aborted', 'operator-pause');
  }, resume() { state.paused = false; }, notifySkipped() {
    frame = null;
    if (state.phase === 'dispatched') transition('aborted', 'skipped');
  } };
}
module.exports = { createWalkerReplay };
