'use strict';
/* PRNG deterministico (mulberry32) para humanizacao reproduzivel. */
function createSeededRandom(seed) {
  let state = (Number(seed) >>> 0) || 1;
  return function random() {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
module.exports = { createSeededRandom };
