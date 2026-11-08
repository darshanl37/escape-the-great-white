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
const VW = 450, VH = 800, LEVELS = 20, EDGE = 50;

/* ------------------------------------------------------------------ *
 * Load one fresh instance of the game.
 * ------------------------------------------------------------------ */
function load(storage = {}) {
  const src = fs.readFileSync(HTML, 'utf8');
  const m = src.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no <script> block found in index.html');

  // Test-only shim: the game is an IIFE with no exports, so expose the few
  // internals the tests need to observe and drive.
  const HOOK = `globalThis.__game = {
    get state(){return state}, get levelIdx(){return levelIdx},
    get pearls(){return pearls}, get sharks(){return sharks},
    get player(){return player}, get lives(){return lives}, get save(){return save},
    get hammer(){return hammer}, get jellies(){return jellies},
    S, startLevel, playLevel, newGame, openSelect, pause, resume, isOpen };\n`;
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
  const nodes = {}, winHandlers = {}, docHandlers = {};
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
    getAttribute() { return null; },
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
    localStorage: { data: Object.assign({}, storage), getItem(k) { return this.data[k] || null; }, setItem(k, v) { this.data[k] = String(v); } },
    document: { getElementById: el, createElement: el, hidden: false,
      addEventListener(type, fn) { (docHandlers[type] = docHandlers[type] || []).push(fn); } },
    matchMedia: () => ({ matches: false }),
    addEventListener(type, fn) { (winHandlers[type] = winHandlers[type] || []).push(fn); },
    history: { pushed: 0, pushState() { this.pushed++; } },
    location: { search: '' },
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
    tick, el, violations, sandbox,
    fire: (type, ev = {}) => (winHandlers[type] || []).forEach(fn => fn(ev)),
    // tap a tile in the level grid
    pickLevel: i => el('grid').emit('click', { target: { disabled: !sandbox.__game.isOpen(i),
      closest() { return this; }, getAttribute: () => String(i) } }),
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
  console.log('\nrendering — all 20 levels, strict canvas arguments');
  const h = load();
  h.click('btnStart');
  for (let lvl = 0; lvl < LEVELS; lvl++) {
    h.violations.length = 0;
    h.game.playLevel(lvl);
    // 420 frames: long enough for clams to cycle and the hammerhead to warn + dash
    for (let f = 0; f < 420; f++) {
      if (f % 7 === 0) h.pointer('pointermove', 225 + Math.sin(f / 30) * 150, 400 + Math.cos(f / 40) * 250);
      h.game.player.invuln = 5;   // stay alive so every twist gets drawn
      h.tick();
    }
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
    ['retry after losing every heart', g => g.playLevel(g.levelIdx)],
    ['level 14 (riptide)', g => g.playLevel(13)]
  ];
  for (const [label, transition] of cases) {
    const h = load();
    h.click('btnStart');
    h.game.playLevel(0);
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

/* Steer a finger so the swimmer heads for the nearest open pearl. The bot
 * swims in straight lines, so when a rock (plus a current pushing it into the
 * rock) pins it, it takes a short detour the way a person would. */
function chasePearl(h) {
  const p = h.game.player;
  const s = h.bot || (h.bot = { f: 0, x: p.x, y: p.y, detour: 0, dx: 0, dy: 0 });
  if (++s.f % 60 === 0) {
    if (Math.hypot(p.x - s.x, p.y - s.y) < 12 && !s.detour) {
      s.detour = 45; s.dx = 40 + Math.random() * 370; s.dy = 120 + Math.random() * 560;
    }
    s.x = p.x; s.y = p.y;
  }
  if (s.detour > 0) { s.detour--; h.pointer('pointermove', EDGE + s.dx / VW * (VW - 2 * EDGE), s.dy); return; }
  const left = h.game.pearls.filter(q => !q.got);
  if (!left.length) return;
  let target = left[0], best = Infinity;
  for (const q of left) {
    const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
    if (d < best) { best = d; target = q; }
  }
  // invert the touch lift and the sideways stretch so the finger puts the swimmer on the pearl
  let fingerY = target.y;
  for (let k = 0; k < 12; k++)
    fingerY = target.y + 62 * Math.min(1, Math.max(0, (VH - fingerY) / 130));
  const fingerX = EDGE + target.x / VW * (VW - 2 * EDGE);
  h.pointer('pointermove', fingerX, Math.min(fingerY, VH));
}

/* 3. The level/hearts state machine: levels advance on collecting every pearl,
 *    clearing unlocks the next level, and losing every heart retries the SAME
 *    level — progress is never thrown away. */
function testProgression() {
  console.log('\nprogression — advance, unlock, retry the same level');
  const h = load();
  h.click('btnStart');
  report(h.el('ovSelect').classList.contains('show'), 'Play opens the level select');
  report(!h.game.isOpen(1), 'level 2 starts locked');
  h.pickLevel(0);
  let peakLevel = 0, sawOver = false, overLevel = -1, retriedSame = false;

  for (let f = 0; f < 60000; f++) {
    if (h.el('ovCaught').classList.contains('show')) h.click('btnRetry');
    if (h.el('ovOver').classList.contains('show')) {
      sawOver = true; overLevel = h.game.levelIdx; h.click('btnRestart');
      if (h.game.levelIdx === overLevel && h.game.lives === 3) retriedSame = true;
    }
    if (h.el('ovWin').classList.contains('show')) break;
    chasePearl(h);
    h.tick();
    if (h.game.levelIdx > peakLevel) peakLevel = h.game.levelIdx;
    if (sawOver && peakLevel >= 2) break;
  }
  report(peakLevel >= 1, 'level 2 starts after clearing level 1');
  report(peakLevel >= 2, 'levels keep advancing', `reached level ${peakLevel + 1}`);
  report(h.game.save.unlocked >= peakLevel + 1, 'cleared levels unlock the next', `unlocked ${h.game.save.unlocked}`);
  report(h.game.save.stars[0] >= 1, 'stars recorded for level 1', `${h.game.save.stars[0]}`);
  report(sawOver && retriedSame, 'out of hearts retries the same level with 3 hearts', `over on level ${overLevel + 1}`);
  const stored = JSON.parse(h.sandbox.localStorage.getItem('egw.save') || 'null');
  report(stored && stored.unlocked === h.game.save.unlocked, 'progress saved to localStorage');
  report(h.violations.length === 0, 'no bad canvas arguments during play');

  // a fresh page load picks up where you left off
  const h3 = load({ 'egw.save': JSON.stringify({ unlocked: 7, stars: [3, 2, 1] }) });
  report(h3.game.isOpen(6) && !h3.game.isOpen(7), 'saved progress restores on reload');
  const h4 = load({ 'egw.best': '12' });
  report(h4.game.isOpen(11) && !h4.game.isOpen(12), 'old "best level 12" score carries over');
  h4.click('btnStart');
  h4.pickLevel(15);
  report(h4.game.state !== h4.game.S.INTRO, 'a locked tile does nothing');
  h4.pickLevel(11);
  report(h4.game.levelIdx === 11 && h4.game.state === h4.game.S.INTRO, 'an open tile starts that level');
}

/* 4. Every level is clearable: with the sharks unable to bite, a simple bot
 *    collects every pearl (clams open, currents and whirlpools can be swum). */
function testClearable() {
  console.log('\nreachability — every pearl on every level can be collected');
  for (let lvl = 0; lvl < LEVELS; lvl++) {
    let worst = 0, ok = true;
    for (let trial = 0; trial < 3; trial++) {
      const h = load();
      h.click('btnStart');
      h.game.playLevel(lvl);
      let f = 0;
      for (; f < 5000; f++) {
        h.game.player.invuln = 5;
        chasePearl(h);
        h.tick();
        if (h.game.levelIdx !== lvl || h.game.state === h.game.S.WIN) break;
      }
      if (f >= 5000) ok = false;
      worst = Math.max(worst, f);
    }
    report(ok, `level ${String(lvl + 1).padStart(2)}`, `slowest ${(worst / 60).toFixed(1)}s`);
  }
}

/* 5. Edge swipes. The phone's back gesture must pause the game, not close it,
 *    and the swimmer must reach both walls without the finger touching an edge. */
function testBackGesture() {
  console.log('\nphone back-swipe and edge reach');
  const h = load();
  h.click('btnStart');
  report(h.sandbox.history.pushed === 1, 'a spare history entry is pushed on Play');
  h.game.playLevel(3);
  for (let f = 0; f < 150; f++) h.tick();
  report(h.game.state === h.game.S.PLAY, 'playing');
  h.fire('popstate');
  report(h.game.state === h.game.S.PAUSE && h.el('ovPause').classList.contains('show'), 'back-swipe pauses instead of leaving');
  const frozen = h.game.sharks[0].x;
  for (let f = 0; f < 60; f++) h.tick();
  report(h.game.sharks[0].x === frozen, 'nothing moves while paused');
  h.pointer('pointerdown', 200, 400);
  report(h.sandbox.history.pushed === 2, 'the guard re-arms on the next touch');
  h.click('btnResume');
  for (let f = 0; f < 40; f++) h.tick();
  report(h.game.state === h.game.S.PLAY, 'resume continues the same level', `level ${h.game.levelIdx + 1}`);

  // finger 11% in from each edge must still put the swimmer against the wall
  // (level 1: no rocks in the way)
  h.game.playLevel(0);
  for (let f = 0; f < 150; f++) h.tick();
  h.game.player.invuln = 999;
  h.pointer('pointermove', EDGE + 2, 400);
  for (let f = 0; f < 200; f++) { h.game.player.invuln = 999; h.tick(); }
  const leftX = h.game.player.x;
  h.pointer('pointermove', VW - EDGE - 2, 400);
  for (let f = 0; f < 250; f++) { h.game.player.invuln = 999; h.tick(); }
  const rightX = h.game.player.x;
  report(leftX < 20 && rightX > VW - 20, 'walls reachable without touching a screen edge',
    `x ${leftX.toFixed(0)} … ${rightX.toFixed(0)}`);

  // a pending level-clear can't be cancelled by pausing (would strand you on an empty level)
  const g = load();
  g.click('btnStart'); g.game.playLevel(0);
  for (let f = 0; f < 120; f++) g.tick();
  g.game.pearls.forEach(p => { p.x = g.game.player.x; p.y = g.game.player.y; });
  g.tick();
  g.fire('popstate');
  for (let f = 0; f < 200; f++) g.tick();
  report(g.game.levelIdx === 1, 'back-swipe during level-clear still moves on to the next level');
}

/* 6. The level table is the tuning surface; keep its shape honest. */
function testLevelTable() {
  console.log('\nlevel table');
  const src = fs.readFileSync(HTML, 'utf8');
  const table = eval(src.match(/const LEVELS = (\[[\s\S]*?\n\]);/)[1]);
  report(table.length === LEVELS, 'twenty levels defined', `${table.length}`);

  const pace = parseFloat(src.match(/const PACE = ([\d.]+)/)[1]);
  const playerSpeed = 4.15 * pace;
  let monotonic = true, escapable = true, named = true;
  for (let i = 0; i < table.length; i++) {
    const L = table[i];
    // the shark must never simply out-swim you: every level has to be escapable
    const fastest = L.speed * (L.mega ? 0.92 : 1) * pace;
    if (fastest >= playerSpeed) escapable = false;
    // the original twelve keep their calibrated ramp
    if (i && i < 12 && table[i].pearls < table[i - 1].pearls) monotonic = false;
    if (i >= 12 && !(L.name && L.icon)) named = false;
  }
  report(escapable, 'shark never out-cruises the swimmer on any level');
  report(monotonic, 'levels 1-12: pearl count never decreases');
  report(named, 'levels 13-20 each have a name and an icon');
  // the original twelve rows are unchanged (difficulty was calibrated by a real player)
  const orig = [1.70,1.90,2.10,2.30,2.50,2.65,2.80,2.95,3.10,2.85,3.05,3.25];
  report(orig.every((s, i) => table[i].speed === s), 'levels 1-12 shark speeds untouched');
}

console.log('Escape the Great White — headless tests');
testRendering();
testHeldPointer();
testProgression();
testClearable();
testBackGesture();
testLevelTable();
console.log(failures ? `\n${failures} failure(s)\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
