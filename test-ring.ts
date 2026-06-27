// Validates the SPSC ring arithmetic: losslessness, ordering, wrap-around, and
// full/empty disambiguation. Interleaves produce/consume in one thread (SAB +
// Atomics behave identically; only the index math can be wrong, and that's what
// we exercise here).

import { createRingSAB, RingProducer, RingConsumer, RING_CAPACITY } from "./src/sim/audio-ring.ts";

const sab = createRingSAB();
const prod = new RingProducer(sab);
const cons = new RingConsumer(sab);

const TOTAL = 5_000_000; // ~100s of audio; many wraps
const PROD_CHUNK = 800;
const CONS_CHUNK = 128;

let nextProduce = 0; // value to write next
let nextExpect = 0; // value we expect to read next
let produced = 0;
let consumed = 0;
let underruns = 0;
let errors = 0;

const wbuf = new Float32Array(PROD_CHUNK);
const rbuf = new Float32Array(CONS_CHUNK);

// Use integers small enough to be exact in Float32 (< 2^24).
const enc = (v: number) => v % 16_000_000;

let guard = 0;
while (consumed < TOTAL && guard++ < 200_000_000) {
  const doProduce = Math.random() < 0.5;
  if (doProduce && produced < TOTAL && prod.free() >= PROD_CHUNK) {
    for (let i = 0; i < PROD_CHUNK; i++) wbuf[i] = enc(nextProduce + i);
    if (prod.write(wbuf, PROD_CHUNK)) {
      nextProduce += PROD_CHUNK;
      produced += PROD_CHUNK;
    }
  } else {
    // Only consume when full block is available, so every read is a real sample
    // and must equal the running expectation.
    if (cons.fill() >= CONS_CHUNK) {
      const got = cons.read(rbuf);
      for (let i = 0; i < got; i++) {
        if (rbuf[i] !== enc(nextExpect)) { errors++; }
        nextExpect++;
      }
      consumed += got;
    } else if (produced >= TOTAL) {
      // drain tail
      const got = cons.read(rbuf);
      for (let i = 0; i < got; i++) {
        if (rbuf[i] !== enc(nextExpect)) errors++;
        nextExpect++;
      }
      if (got === 0) break;
      consumed += got;
    } else {
      underruns++;
    }
  }
}

// Sanity: never report fill > capacity, never negative free.
let invariantOk = true;
for (let t = 0; t < 1000; t++) {
  if (prod.fill() > RING_CAPACITY || prod.free() < 0) invariantOk = false;
}

console.log(
  `produced=${produced} consumed=${consumed} seqErrors=${errors} ` +
  `benignUnderrunPolls=${underruns} invariantOk=${invariantOk}`,
);
console.log(errors === 0 && consumed === produced && invariantOk ? "RING OK" : "RING FAILED");
