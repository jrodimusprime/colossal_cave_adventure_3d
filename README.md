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
- **Gloomkins** throw knives from the dark (the first one always misses). Throw your axe back, then go and pick it up.
- **The shade** steals treasure and hides it in a nest somewhere nearby.
- **Reincarnation.** You get three. Your belongings stay where you fell.

## Controls

| Key | Action |
| --- | --- |
| W A S D, mouse | move, look (Shift run, Space jump) |
| E | take / use (ropes, trunk, barrel, standing stones) |
| F / R / X | lamp on-off / refuel / eat |
| Click | throw axe |
| M, I, L | map, inventory, look |
| Enter | type a command |
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
