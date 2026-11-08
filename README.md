# escape-the-great-white

A twenty-level underwater chase game for young kids. One HTML file, no
dependencies, no build step. Swim away from the great white and collect every
glowing pearl to clear a level. Three hearts per level; clearing a level
unlocks the next, and you can replay any open level from the level select.
Hearts left at the end become stars.

Levels 13-20 each add one twist: jellyfish that sting (slow you down),
riptide currents, a hammerhead that dashes across a warned row, pearls in
clams that open and shut, lights out, a whirlpool, a shark pack, and the
Megalodon. Bubble shields block one bite each.

On phones, a swipe in from the screen edge is the system "back" gesture. The
game keeps a spare history entry so that swipe pauses instead of closing the
tab, and touch is stretched sideways so the swimmer reaches each wall before
the finger reaches the screen edge. `?all` in the URL opens every level for
that visit.

Built for touch first: hold a finger anywhere and the swimmer follows it.
Keyboard (arrows / WASD) works too.

## Run it

Open `index.html` in a browser. That is the whole thing — it works from the
filesystem, offline, and from any static host.

## How it works

A single `<canvas>` drawn procedurally at a fixed 450x800 virtual resolution,
scaled to fit the viewport. No sprites or audio files: the art is canvas paths
and the sound effects are oscillators. The only external request is Google
Fonts, and the page degrades cleanly without it.

## Tuning the difficulty

Every level is one row of a table near the top of the script:

```js
const LEVELS = [
  { speed:1.70, turn:0.026, sharks:1, pearls:3, rocks:0, kelp:1, lunge:false, lead:0,  pup:1 },
  ...
];
```

| field | meaning |
| --- | --- |
| `speed` | shark cruise speed |
| `turn` | how fast it can rotate — a low value means it overshoots and you can juke it |
| `sharks` | how many |
| `pearls` | how many to collect to clear the level |
| `rocks` | obstacles; sharks bounce off and are briefly stunned |
| `kelp` | slow-zones for sharks, free passage for the swimmer |
| `lunge` | whether it winds up and charges |
| `lead` | frames of aim-ahead; `0` chases where you are, higher aims where you are going |
| `pup` | size and speed multiplier for the second shark |

`PACE` is a global multiplier applied to shark speed, shark turn rate and
swimmer speed together. Because turning circle is speed divided by turn rate,
scaling both leaves every turning circle and speed ratio untouched — so `PACE`
changes how fast the game feels without changing how hard it is.

## Design notes

**Depth is the difficulty curve.** The water darkens from level 1 to 12, the
sunbeams fade out and the pearls turn bioluminescent. Progress is visible in
the art, not just the level counter.

**The shark never out-swims you.** It peaks at about 80% of the swimmer's speed
even on level 12. Only the telegraphed charge is faster, so every level is
escapable by turning rather than by racing.

**A closing shark commits.** Within roughly a body length it can barely steer,
so a last-moment sidestep always beats it. Deaths read as "too slow" instead of
"it stuck to me", which is what makes it learnable.

**Only the mouth bites.** Brushing the tail is free. Generous, and it teaches
positioning rather than blanket avoidance.

**No instructions.** The title screen is playable — the swimmer follows your
finger before you press Play — so the control teaches itself.

## Tests

```
node test/run.js
```

Runs the real game script in a Node vm against a stub DOM, a stub 2D context
and a virtual clock. It checks that all twenty levels render, that the level
and lives state machine advances and resets, and that the level table stays
sane.

Two stubs are deliberately strict, because permissive ones hid real bugs:

- The canvas rejects any argument that is not a finite number or a string. A
  lax stub once swallowed a `NaN` reaching `createLinearGradient`, which threw
  in a real browser and killed the animation loop on every level that contained
  a rock.
- Input is driven with real pointer events, including the case that matters
  most: a finger already pressed and holding still, which emits no events at
  all. Re-deriving the aim only inside event handlers left the swimmer frozen
  after every level change.

## Deploying

Copy `index.html` to any static host. Keep the `<meta name="viewport">` tag —
without it phones lay the page out at 980px wide and the game is unplayable.
The black bars on very tall screens are intentional: the play area is locked to
450x800 so the difficulty does not depend on screen shape.

## License

MIT
