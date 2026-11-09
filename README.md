# The Endless Cave

A 3D cave-exploration adventure inspired by the 1970s text adventures, rendered in a low-poly, 1996-style software-renderer look. Pure HTML + JavaScript + WebGL2: no build step, no libraries, no asset files.

**Play:** open `index.html` in a browser (or the GitHub Pages link for this repo).

## The idea

The classic cave adventures had no plot, only a premise: there is a cave, it is full of treasure, go and get it. This game keeps that premise and makes the cave literally endless:

- The world is generated from a seed in 32×32-cell chunks, infinitely in every horizontal direction, on an infinite stack of levels.
- Chunk edges share hashed "portal" passages, so the whole cave is always connected.
- Rope shafts in one level line up with landing chambers in the level below. Deeper levels (Upper Galleries → Limestone Deeps → Crystal Reaches → Fungal Abyss → Ember Depths → the Nameless Dark) hold more valuable treasure and more danger.

## Mechanics

- **Treasure and score.** Finding a treasure scores a little; carrying it back to the trunk at camp scores its full value. New places and new depths also score. You carry at most 7 things.
- **The lamp.** It burns oil. Refill it at the camp barrel or with flasks found below. In pitch darkness you may fall into a pit.
- **Typed commands.** Press Enter for a parser: `TAKE ALL`, `DROP IDOL`, `INVENTORY`, `LOOK`, `SCORE`, `FILL`, `EAT`, `SAY <word>`, `BRIEF`/`VERBOSE`, `SAVE`/`RESTORE`, `HELP`.
- **Magic words.** Carved standing stones each bear a word. Say it beside the stone to return to camp, or at camp to return to the stone.
- **Gloomkins** throw knives from the dark (the first one always misses; the very first gloomkin throws its axe instead, which is how you get one). Every attack is telegraphed: an arm goes back before a knife flies, a crouch before a lunge. Click to swing your axe, right-click or Q to throw it (then go and pick it up). Hits knock them back; deeper gloomkins take two or three.
- **The Cinder Wyrm** sleeps on a hoard of double-value treasure in rare lairs from level 4 down. Your lamplight or running wakes it; sneaking past with the lamp off is possible, if dangerous. It breathes fire (watch for the glowing throat), bites, and sweeps its tail at anyone behind it. It won't leave its lair. Eight axe hits kill it for good (+50).
- **The shade** steals treasure and hides it in a nest somewhere nearby.
- **Reincarnation.** You get three. Your belongings stay where you fell.
- **Puzzles.** Hidden rooms full of richer treasure sit behind obstacles. The thing you need is somewhere in the same stretch of cave:
  - an **iron gate** (find the brass key: `UNLOCK GATE`)
  - a **rusted door** (`OIL DOOR`: it costs you a flask of lamp oil, so light or access?)
  - a **giant mole** blocking its burrow (`FEED MOLE`; don't get too close without food)
  - a **gap** too wide to jump (`BRIDGE GAP` with a bundle of planks)
  - a **dry bulb** under a high shelf (`FILL` a waterskin in an underground lake, `POUR WATER`, then `CLIMB VINE`)
- **Fragile treasure.** Porcelain urns and crystal eggs shatter if you drop them on bare rock, take a hard fall, or die carrying them. Moss, mushroom beds, water and the trunk are safe.
- **Your first weapon comes from your first enemy.** You don't start with an axe: the first gloomkin you meet hurls its axe at you, misses, and runs off.
- **One-way chutes.** Some shafts have no rope: you can slide down (`DOWN` or E), but there's no climbing back. Find another way home.
- **The recall word.** The first time the shade robs you it drops a scrap of cloth with a word on it. Say it and every stolen treasure comes back to camp.
- **The Tangle.** Some sections are mazes of identical tunnels where your map stops working. Drop things to mark your way.
- **The cave closes.** Bank 12 treasures and a bell starts tolling. Be back at camp by the last bell to win (+100), or be sealed in forever. Treasure banked while the bells ring counts double.
- **Hints.** Type `HINT`. It knows what you are stuck on, but costs 5 points (you're asked to confirm first).
- **Autopilot.** "Watch the AI play" on the title screen (or B) hands the game to an AI at 5× speed. It explores, fights, banks treasure, uses magic words and solves puzzles, typing its commands as it goes. "Autopilot: go home" on the pause screen (or G) takes you back to camp. Any key takes back control.

## How the AI plays

- **It only knows what it has seen.** Items, puzzles, lakes and ropes go into its memory when they come into its lamplight with a clear line of sight. It never reads the level generator.
- **It explores frontiers.** When there's nothing better to do, it heads for the nearest edge between cells it has seen and cells it hasn't, just like a player pushing into the dark. This uses its own memory, so it works in the Tangle where the in-game map doesn't.
- **It plans puzzles with GOAP (goal-oriented action planning).** Each command is an action with preconditions and effects (`TAKE waterskin` gives you the waterskin; `FILL` needs the waterskin and a lake; `POUR WATER` needs a full waterskin...). For each remembered puzzle, a Dijkstra search over world states finds the cheapest chain of actions to its treasure, costed by walking distance, and the AI announces it in the log, e.g. `[AI plan: fill the waterskin at the lake -> water the bulb -> climb the vine to the shelf]`. It replans from the real game state after every step, so a stolen key or a vanished item just produces a new plan.
- **Reactive priorities sit on top**: fighting, refuelling, eating, fetching its axe, going home when the pack is full, and running for camp when the cave starts to close.
- **Paths are A\*** over the cave grid, with clearance around stalagmites, columns and rocks.

## Controls

| Key | Action |
| --- | --- |
| W A S D, mouse | move, look (Shift run, Space jump) |
| E | take / use (ropes, trunk, barrel, standing stones) |
| F / R / X | lamp on-off / refuel / eat |
| Click | swing axe |
| Right-click / Q | throw axe |
| M, I, L | map, inventory, look |
| Enter | type a command |
| B | let the AI play at 5× speed |
| G | autopilot home: walk back to camp, bank treasure, refill (any key takes back control) |
| P, K, Esc | pixel size, sound, pause |

## Code

| File | Purpose |
| --- | --- |
| `js/util.js` | hashing, seeded RNG, value noise, matrices |
| `js/textures.js` | procedural 64×64 palette textures (alpha = emissive mask) |
| `js/world.js` | infinite chunk generation, rooms, tunnels, shafts, items, descriptions |
| `js/mesh.js` | low-poly chunk meshes, props, baked vertex lighting, entity models |
| `js/renderer.js` | WebGL2 renderer: low-res target, banded light, fog, upscale |
| `js/audio.js` | synthesised WebAudio sound |
| `js/game.js` | player, parser, creatures, lamp, map, save/load, HUD |
| `js/combat.js` | creatures, jointed-model animation, melee, knockback, the Cinder Wyrm |
| `js/autopilot.js` | the AI player: memory, frontier exploration, GOAP planner, A* pathfinding |

## Credits

- Dragon model: **"Animated Monsters" by Quaternius**, CC0 1.0 (public domain), https://quaternius.com. Its skeletal animations were baked into per-vertex keyframes, Quake-style, and recoloured with the game's procedural textures.
- Everything else (textures, models, sound, levels) is generated in code.
