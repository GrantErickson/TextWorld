/**
 * Built-in maps.
 *
 * These are kept as source text rather than as objects because the editor pane
 * shows exactly what a map author writes. What loads the world and what you
 * read in the textarea are the same bytes, so nothing can drift between them.
 */

export interface Preset {
  id: string;
  label: string;
  source: string;
}

/**
 * The showcase map: two lit halls, a hand-operated door, two automatic ones,
 * a sealed alcove whose brazier throws light out through its doorway, and a
 * drone that carries its own light down the east hall so you can watch shadows
 * swing as it passes.
 */
const VAULT = `{
  "name": "The Vault",
  "grid": [
    "############################",
    "#..........#...............#",
    "#..........#...............#",
    "#....##....+.....###.......#",
    "#....##....#.....#.#.......#",
    "#..........#.....#.#.......#",
    "#..........#.....#+#.......#",
    "#####/#####*...............#",
    "#..........#...............#",
    "#..........############/####",
    "#..........#...............#",
    "#....##....#...............#",
    "#....##....#....##...##....#",
    "#..........#....##...##....#",
    "#..........#...............#",
    "############################"
  ],
  "spawn": { "x": 2.5, "y": 9.5, "angle": 0 },
  "ambient": 0.09,
  "ambientColor": "#3d4f70",
  "exposure": 4.6,
  "contrast": 1.85,
  "fog": { "color": "#0e1420", "density": 0.04 },
  "materials": {
    "brick":  { "color": "#b08a68", "pattern": "brick",  "roughness": 0.8 },
    "rough":  { "color": "#9aa3ae", "pattern": "rock",   "roughness": 0.75 },
    "floor":  { "color": "#7d8496", "pattern": "tile",   "roughness": 0.5 },
    "ceil":   { "color": "#5a6172", "pattern": "panel",  "roughness": 0.35 },
    "timber": { "color": "#c99a52", "pattern": "planks", "roughness": 0.7 },
    "steel":  { "color": "#98a6b6", "pattern": "panel",  "roughness": 0.55 }
  },
  "legend": {
    "#": { "wall": "brick", "floor": "floor", "ceiling": "ceil" },
    "*": { "wall": "rough", "floor": "floor", "ceiling": "ceil" },
    ".": { "floor": "floor", "ceiling": "ceil" },
    "+": { "door": "timber", "floor": "floor", "ceiling": "ceil" },
    "/": { "door": "steel", "auto": true, "floor": "floor", "ceiling": "ceil" }
  },
  "lights": [
    { "x": 3.5,  "y": 2.5,  "radius": 5.5, "color": "#ffcf9a", "intensity": 1.9, "flicker": 0.22 },
    { "x": 9.5,  "y": 5.5,  "radius": 4.5, "color": "#ffc890", "intensity": 1.6, "flicker": 0.25 },
    { "x": 3.5,  "y": 12.5, "radius": 5.5, "color": "#ffcf9a", "intensity": 1.9, "flicker": 0.22 },
    { "x": 9.5,  "y": 8.5,  "radius": 4.5, "color": "#a9c8ff", "intensity": 1.3 },
    { "x": 14.5, "y": 2.5,  "radius": 6.0, "color": "#bcd6ff", "intensity": 1.5 },
    { "x": 25.5, "y": 6.5,  "radius": 6.0, "color": "#9fc0ff", "intensity": 1.4 },
    { "x": 19.5, "y": 12.5, "radius": 6.5, "color": "#ffd2a0", "intensity": 1.8, "flicker": 0.3 },
    { "x": 13.5, "y": 13.5, "radius": 5.0, "color": "#89b4ff", "intensity": 1.2 }
  ],
  "entities": [
    {
      "sprite": "brazier", "x": 18.5, "y": 4.5,
      "light": { "radius": 10, "color": "#ffb066", "intensity": 2.2, "flicker": 0.45 }
    },
    { "sprite": "crate",  "x": 2.6,  "y": 13.4 },
    { "sprite": "crate",  "x": 3.5,  "y": 13.6 },
    { "sprite": "barrel", "x": 9.4,  "y": 8.6 },
    { "sprite": "plant",  "x": 8.6,  "y": 2.5 },
    { "sprite": "pillar", "x": 13.5, "y": 5.5 },
    { "sprite": "pillar", "x": 13.5, "y": 7.5 },
    { "sprite": "monolith", "x": 25.5, "y": 2.5 },
    {
      "sprite": "drone", "x": 14.5, "y": 10.5, "speed": 1.15, "bob": 0.06,
      "path": [[14.5, 10.5], [25.5, 10.5], [25.5, 14.5], [14.5, 14.5]],
      "light": { "radius": 7, "color": "#bfe4ff", "intensity": 1.5 }
    }
  ]
}
`;

/**
 * Outdoors. The cloister has a ceiling and the courtyard does not, so the two
 * sit side by side in one view: enclosed corridor on the left of the arch,
 * open sky beyond it.
 */
const COURT = `{
  "name": "Night Court",
  "grid": [
    "##########################",
    "#........................#",
    "#.##########//##########.#",
    "#.#,,,,,,,,,,,,,,,,,,,,#.#",
    "#.#,,,,,,,,,,,,,,,,,,,,#.#",
    "#.#,,,,,,,,,,,,,,,,,,,,#.#",
    "#.#,,,,,,,,####,,,,,,,,#.#",
    "#.#,,,,,,,,#..#,,,,,,,,#.#",
    "#.#,,,,,,,,#..#,,,,,,,,#.#",
    "#.#,,,,,,,,#/##,,,,,,,,#.#",
    "#.#,,,,,,,,,,,,,,,,,,,,#.#",
    "#.#,,,,,,,,,,,,,,,,,,,,#.#",
    "#.##########//##########.#",
    "#........................#",
    "##########################"
  ],
  "spawn": { "x": 5.5, "y": 10.5, "angle": -45 },
  "ambient": 0.12,
  "ambientColor": "#4a67a0",
  "exposure": 3.5,
  "contrast": 1.9,
  "fog": { "color": "#111a2c", "density": 0.03 },
  "sky": { "top": "#060a18", "horizon": "#27395e", "stars": 0.65 },
  "materials": {
    "stone":  { "color": "#a7adb8", "pattern": "rock",  "roughness": 0.7 },
    "flag":   { "color": "#7f8695", "pattern": "tile",  "roughness": 0.5 },
    "vault":  { "color": "#616a7d", "pattern": "panel", "roughness": 0.4 },
    "moss":   { "color": "#6d7c66", "pattern": "noise", "roughness": 0.8 },
    "gate":   { "color": "#aab6c4", "pattern": "grate", "roughness": 0.85 }
  },
  "legend": {
    "#": { "wall": "stone", "floor": "flag", "ceiling": "vault" },
    ".": { "floor": "flag", "ceiling": "vault" },
    ",": { "floor": "moss", "sky": true },
    "/": { "door": "gate", "auto": true, "floor": "flag", "ceiling": "vault" }
  },
  "lights": [
    { "x": 2.5,  "y": 1.5,  "radius": 8,  "color": "#ffc178", "intensity": 1.6, "flicker": 0.3 },
    { "x": 23.5, "y": 1.5,  "radius": 8,  "color": "#ffc178", "intensity": 1.6, "flicker": 0.3 },
    { "x": 2.5,  "y": 13.5, "radius": 8,  "color": "#ffc178", "intensity": 1.6, "flicker": 0.3 },
    { "x": 23.5, "y": 13.5, "radius": 8,  "color": "#ffc178", "intensity": 1.6, "flicker": 0.3 },
    { "x": 12.5, "y": 3.5,  "radius": 10, "color": "#8fb4ff", "intensity": 1.0 },
    { "x": 12.5, "y": 11.5, "radius": 10, "color": "#8fb4ff", "intensity": 1.0 }
  ],
  "entities": [
    {
      "sprite": "brazier", "x": 12.5, "y": 7.5,
      "light": { "radius": 12, "color": "#ffa855", "intensity": 2.4, "flicker": 0.5 }
    },
    { "sprite": "monolith", "x": 5.5,  "y": 4.5 },
    { "sprite": "monolith", "x": 19.5, "y": 4.5 },
    { "sprite": "monolith", "x": 5.5,  "y": 10.5 },
    { "sprite": "monolith", "x": 19.5, "y": 10.5 },
    { "sprite": "plant", "x": 8.5,  "y": 7.5 },
    { "sprite": "plant", "x": 16.5, "y": 7.5 },
    { "sprite": "plant", "x": 12.5, "y": 4.5 },
    {
      "sprite": "drone", "x": 6.5, "y": 6.5, "speed": 0.9,
      "path": [[6.5, 5.5], [18.5, 5.5], [18.5, 9.5], [6.5, 9.5]],
      "light": { "radius": 7.5, "color": "#c8ecff", "intensity": 1.5 }
    }
  ]
}
`;

/**
 * The smallest thing that still reads as a room. No legend and no materials:
 * unlisted characters fall back to wall, '.' and spaces to floor, so plain
 * ASCII art is a valid map. Handy as a starting point to edit.
 */
const BARE = `{
  "name": "First Light",
  "grid": [
    "#########",
    "#.......#",
    "#.......#",
    "#...#...#",
    "#.......#",
    "#.......#",
    "#########"
  ],
  "spawn": { "x": 1.5, "y": 1.5, "angle": 40 },
  "ambient": 0.11,
  "exposure": 7.0,
  "contrast": 1.8,
  "lights": [
    { "x": 6.5, "y": 3.5, "radius": 6.5, "intensity": 2.4, "flicker": 0.2 }
  ]
}
`;

/**
 * Generated worlds. A `generate` block replaces `grid` entirely: the terrain
 * comes from Wave Function Collapse over the theme's sample art and streams
 * forever as you walk. Change the seed for a different world in the same
 * style; anything else the map format understands still layers on top, so
 * `"exposure"` or `"fog"` here will override what the theme chose.
 */
const ENDLESS_CATACOMBS = `{
  "name": "Endless Catacombs",
  "generate": { "theme": "catacombs", "seed": 1337 }
}
`;

const ENDLESS_CAVERNS = `{
  "name": "Endless Caverns",
  "generate": { "theme": "caverns", "seed": 90210 }
}
`;

const ENDLESS_STATION = `{
  "name": "Endless Station",
  "generate": { "theme": "station", "seed": 4242 }
}
`;

/**
 * Outdoor worlds. Same `generate` block, but these themes build a heightmap
 * from noise rather than solving for characters — so the land has elevation,
 * and walking away and back gives you the same hills rather than new ones.
 */
const ENDLESS_WILDS = `{
  "name": "Endless Wilds",
  "generate": { "theme": "wilds", "seed": 2024 }
}
`;

const ENDLESS_BADLANDS = `{
  "name": "Endless Badlands",
  "generate": { "theme": "badlands", "seed": 815 }
}
`;

const ENDLESS_CITY = `{
  "name": "Endless City",
  "generate": { "theme": "city", "seed": 7 }
}
`;

export const PRESETS: Preset[] = [
  { id: 'gen-city', label: '∞ City', source: ENDLESS_CITY },
  { id: 'gen-wilds', label: '∞ Wilds', source: ENDLESS_WILDS },
  { id: 'gen-badlands', label: '∞ Badlands', source: ENDLESS_BADLANDS },
  { id: 'gen-catacombs', label: '∞ Catacombs', source: ENDLESS_CATACOMBS },
  { id: 'gen-caverns', label: '∞ Caverns', source: ENDLESS_CAVERNS },
  { id: 'gen-station', label: '∞ Station', source: ENDLESS_STATION },
  { id: 'vault', label: 'The Vault', source: VAULT },
  { id: 'court', label: 'Night Court', source: COURT },
  { id: 'bare', label: 'First Light', source: BARE },
];

export function presetById(id: string): Preset {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[0];
}
