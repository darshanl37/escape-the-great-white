/*
 * Headless tests for Escape the Great White.
 *
 * The game is one <script> in index.html that talks to a canvas and the DOM.
 * Rather than drive a real browser, this runs that exact script inside a Node
 * vm against a stub DOM, a stub 2D context and a virtual clock, so frames and
 * timers can be stepped deterministically.
 *
 * Two of the stubs are deliberately strict, because lax ones hid real bugs:
 *
 *   - The canvas records any argument that is not a finite number or a string.
 *     A permissive stub once swallowed a NaN passed to createLinearGradient,
 *     which threw in a real browser and killed the animation loop from level 2
 *     onward.
 *   - Input is driven with real pointer events. Synthesising a fresh event every
 *     frame hides the case that actually matters: a finger already pressed and
 *     holding still, which emits no events at all.
 *
 * Usage:  node test/run.js
 * Exits non-zero if any check fails.
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const HTML = path.join(__dirname, '..', 'index.html');
const VW = 450, VH = 800, LEVELS = 12;

/* ------------------------------------------------------------------ *
 * Load one fresh instance of the game.
 * ------------------------------------------------------------------ */
function load() {
  const src = fs.readFileSync(HTML, 'utf8');
  const m = src.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no <script> block found in index.html');

  // Test-only shim: the game is an IIFE with no exports, so expose the few
  // internals the tests need to observe and drive.
  const HOOK = `globalThis.__game = {
    get state(){return state}, get levelIdx(){return levelIdx},
    get pearls(){return pearls}, get sharks(){return sharks},
    get player(){return player}, S, startLevel, newGame };\n`;
  const marker = 'requestAnimationFrame(frame);';
  const i = m[1].lastIndexOf(marker);
  if (i < 0) throw new Error('could not find the frame-loop kickoff to hook');
  const js = m[1].slice(0, i) + HOOK + m[1].slice(i);

  // --- virtual clock -------------------------------------------------
  let now = 0, timers = [], rafs = [], nextId = 1;
  function tick() {
    now += 1000 / 60;
    const due = timers.filter(t => t.at <= now);
    timers = timers.filter(t => t.at > now);
    due.sort((a, b) => a.at - b.at).forEach(t => t.fn());
    const queued = rafs; rafs = [];
    queued.forEach(fn => fn(now));
  }

  // --- strict 2D context --------------------------------------------
  const violations = [];
  const ARRAY_OK = new Set(['setLineDash']);
  const NUMERIC_PROPS = new Set([
    'globalAlpha', 'lineWidth', 'shadowBlur', 'shadowOffsetX',
    'shadowOffsetY', 'miterLimit'
  ]);
  const check = (name, args) => {
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (typeof a === 'string' || typeof a === 'boolean') continue;
      if (ARRAY_OK.has(name) && Array.isArray(a)) continue;
      if (typeof a === 'number' && Number.isFinite(a)) continue;
      violations.push(`${name}() arg#${i} = ${typeof a === 'object' ? '[object]' : String(a)}`);
    }
  };
  const ctx = new Proxy({}, {
    get(target, key) {
      if (key === 'createLinearGradient' || key === 'createRadialGradient')
        return (...args) => { check(key, args); return { addColorStop() {} }; };
      if (key in target) return target[key];
      if (typeof key !== 'string' || key === 'then') return undefined;
      return (...args) => check(key, args);
    },
    set(target, key, value) {
      if (NUMERIC_PROPS.has(key) && !(typeof value === 'number' && Number.isFinite(value)))
        violations.push(`${key} = ${String(value)}`);
      target[key] = value;
      return true;
    }
  });

  // --- stub DOM ------------------------------------------------------
  const nodes = {};
  const el = id => nodes[id] || (nodes[id] = {
    id, textContent: '', innerHTML: '', hidden: false, offsetWidth: 0, children: [],
    style: new Proxy({}, { get: () => '', set: () => true }),
    handlers: {},
    classList: {
      set: new Set(),
      add(c) { this.set.add(c); },
      remove(c) { this.set.delete(c); },
      contains(c) { return this.set.has(c); }
    },
    addEventListener(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); },
    emit(type, ev) { (this.handlers[type] || []).forEach(fn => fn(ev)); },
    setAttribute() {}, setPointerCapture() {}, releasePointerCapture() {},
    getContext: () => ctx,
    // client coords map 1:1 onto arena coords, which keeps the tests readable
    getBoundingClientRect: () => ({ left: 0, top: 0, width: VW, height: VH, right: VW, bottom: VH })
  });

  const sandbox = {
    console,
    performance: { now: () => now },
    setTimeout: (fn, delay) => { timers.push({ at: now + (delay || 0), fn, id: nextId }); return nextId++; },
    clearTimeout() {}, setInterval() {},
    requestAnimationFrame: fn => { rafs.push(fn); return rafs.length; },
    localStorage: { data: {}, getItem(k) { return this.data[k] || null; }, setItem(k, v) { this.data[k] = String(v); } },
    document: { getElementById: el, createElement: el },
    matchMedia: () => ({ matches: false }),
    addEventListener() {},
    ResizeObserver: class { observe() {} },
    // AudioContext is deliberately absent; the game guards it in a try/catch
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.devicePixelRatio = 2;
  vm.createContext(sandbox);
  vm.runInContext(js, sandbox);

  const canvas = el('game');
  return {
    game: sandbox.__game,
    tick, el, violations,
    click: id => el(id).emit('click', {}),
    // `kind` defaults to touch, which is what the game is actually played with
    pointer: (type, x, y, kind = 'touch') => canvas.emit(type, {
      clientX: x, clientY: y, pointerType: kind, pointerId: 1,
      buttons: 1, preventDefault() {}
    })
  };
}

/* ------------------------------------------------------------------ */
let failures = 0;
function report(ok, label, detail) {
  if (!ok) failures++;
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${label}${detail ? '   ' + detail : ''}`);
}

/* 1. Every level must render without handing the canvas a bad value.
 *    A non-finite argument throws in a real browser and stops the loop. */
function testRendering() {
  console.log('\nrendering — all 12 levels, strict canvas arguments');
  const h = load();
  h.click('btnStart');
  for (let lvl = 0; lvl < LEVELS; lvl++) {
    h.violations.length = 0;
    h.game.startLevel(lvl);
    for (let f = 0; f < 200; f++) h.tick();
    const bad = [...new Set(h.violations)];
    report(bad.length === 0, `level ${String(lvl + 1).padStart(2)}`,
      bad.length ? bad.slice(0, 3).join(' | ') : '');
  }
}

/* 2. A finger already pressed and holding still emits no events. The swimmer
 *    must keep steering anyway, or the game looks frozen after every level
 *    change and every respawn. */
function testHeldPointer() {
  console.log('\ninput — finger held down, zero further events');
  const cases = [
    ['level 1 -> level 2', g => g.startLevel(1)],
    ['level 5 -> level 6', g => g.startLevel(5)],
    ['restart after being caught', g => g.startLevel(g.levelIdx)],
    ['game over -> level 1', g => g.newGame()]
  ];
  for (const [label, transition] of cases) {
    const h = load();
    h.click('btnStart');
    for (let f = 0; f < 140; f++) h.tick();
    h.pointer('pointerdown', 300, 250);          // pressed once, never moved again
    for (let f = 0; f < 40; f++) h.tick();
    transition(h.game);
    for (let f = 0; f < 160; f++) h.tick();      // past the level card and the start freeze
    const from = { x: h.game.player.x, y: h.game.player.y };
    for (let f = 0; f < 90; f++) h.tick();
    const moved = Math.hypot(h.game.player.x - from.x, h.game.player.y - from.y);
    report(moved > 1, label, `moved ${moved.toFixed(1)} units`);
  }
}

/* 3. The level/lives state machine: levels advance on collecting every pearl,
 *    and losing the last life returns to level 1. */
function testProgression() {
  console.log('\nprogression — advance, respawn, reset to level 1');
  const h = load();
  h.click('btnStart');
  let reachedLevel2 = false, sawReset = false, peakLevel = 0;

  for (let f = 0; f < 40000; f++) {
    // tap through any "Again" / "Play again" prompt without lifting the finger
    for (const [overlay, button] of [['ovCaught', 'btnRetry'], ['ovOver', 'btnRestart'], ['ovWin', 'btnPlayAgain']]) {
      if (h.el(overlay).classList.contains('show')) h.click(button);
    }
    const p = h.game.player;
    const left = h.game.pearls.filter(q => !q.got);
    if (left.length) {
      let target = left[0], best = Infinity;
      for (const q of left) {
        const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
        if (d < best) { best = d; target = q; }
      }
      // invert the touch lift so the finger puts the swimmer on the pearl
      let fingerY = target.y;
      for (let k = 0; k < 12; k++)
        fingerY = target.y + 62 * Math.min(1, Math.max(0, (VH - fingerY) / 130));
      h.pointer('pointermove', target.x, Math.min(fingerY, VH));
    }
    h.tick();
    if (h.game.levelIdx >= 1) reachedLevel2 = true;
    if (h.game.levelIdx > peakLevel) peakLevel = h.game.levelIdx;
    if (reachedLevel2 && peakLevel >= 1 && h.game.levelIdx === 0) sawReset = true;
    if (sawReset && peakLevel >= 2) break;
  }
  report(reachedLevel2, 'level 2 starts after clearing level 1');
  report(peakLevel >= 2, 'levels keep advancing', `reached level ${peakLevel + 1}`);
  report(sawReset, 'out of lives returns to level 1');
  report(h.violations.length === 0, 'no bad canvas arguments during play');
}

/* 4. The level table is the tuning surface; keep its shape honest. */
function testLevelTable() {
  console.log('\nlevel table');
  const src = fs.readFileSync(HTML, 'utf8');
  const table = eval(src.match(/const LEVELS = (\[[\s\S]*?\]);/)[1]);
  report(table.length === LEVELS, 'twelve levels defined', `${table.length}`);

  let monotonic = true, escapable = true;
  const playerSpeed = 4.15 * parseFloat(src.match(/const PACE = ([\d.]+)/)[1]);
  for (let i = 0; i < table.length; i++) {
    const L = table[i];
    // the shark must never simply out-swim you: every level has to be escapable
    if (L.speed * parseFloat(src.match(/const PACE = ([\d.]+)/)[1]) >= playerSpeed) escapable = false;
    if (i && table[i].pearls < table[i - 1].pearls) monotonic = false;
  }
  report(escapable, 'shark never out-cruises the swimmer on any level');
  report(monotonic, 'pearl count never decreases as levels go up');
}

console.log('Escape the Great White — headless tests');
testRendering();
testHeldPointer();
testProgression();
testLevelTable();
console.log(failures ? `\n${failures} failure(s)\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
