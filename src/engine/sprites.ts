import type { SpriteDef } from './types.ts';
import { rgb } from './materials.ts';

/**
 * Sprite art is a density bitmap rather than a glyph bitmap. Each character
 * names how much ink covers that cell; the renderer feeds that density through
 * the same lighting and shading pipeline the walls use, so sprites pick up
 * torchlight, fog and distance exactly like geometry does.
 */
export const DENSITY_CHARS: Record<string, number> = {
  ' ': -1, // transparent
  '.': 0.22,
  ':': 0.42,
  '+': 0.62,
  '*': 0.8,
  '#': 1,
  '@': 1, // solid + self-lit
};

export function isEmissiveChar(ch: string): boolean {
  return ch === '@';
}

function def(
  id: string,
  color: [number, number, number],
  width: number,
  height: number,
  base: number,
  art: string[],
  emissive = 0,
): SpriteDef {
  return { id, color: rgb(color[0], color[1], color[2]), width, height, base, art, emissive };
}

export const SPRITES: Record<string, SpriteDef> = {
  pillar: def('pillar', [150, 148, 138], 0.42, 1.0, 0, [
    '########',
    '########',
    ' :####: ',
    ' :####: ',
    ' :####: ',
    ' :####: ',
    ' :####: ',
    ' :####: ',
    ' :####: ',
    ' :####: ',
    '########',
    '########',
  ]),

  crate: def('crate', [156, 112, 62], 0.6, 0.6, 0, [
    '########',
    '#:+**+:#',
    '#+*##*+#',
    '#+*##*+#',
    '#+*##*+#',
    '#+*##*+#',
    '#:+**+:#',
    '########',
  ]),

  barrel: def('barrel', [122, 98, 70], 0.52, 0.72, 0, [
    ' :####: ',
    '########',
    '#:****:#',
    '#:****:#',
    '########',
    '#:****:#',
    '#:****:#',
    '########',
    ' :####: ',
  ]),

  brazier: def(
    'brazier',
    [255, 176, 96],
    0.5,
    0.95,
    0,
    [
      '  .::.  ',
      ' .:@@:. ',
      ' :@@@@: ',
      '  @@@@  ',
      '  :##:  ',
      '  ####  ',
      '   ##   ',
      '   ##   ',
      '  ####  ',
      ' :####: ',
      '########',
    ],
    0.85,
  ),

  plant: def('plant', [92, 156, 96], 0.7, 0.85, 0, [
    '  . .   ',
    ' :#:#:. ',
    '.:###:#:',
    ':#####:.',
    '.:###:. ',
    '  :#:   ',
    '  ###   ',
    '  ###   ',
    ' :###:  ',
    '#######*',
  ]),

  drone: def(
    'drone',
    [176, 226, 248],
    0.55,
    0.5,
    0.55,
    [
      '  ::::  ',
      ' :####: ',
      ':##@@##:',
      '#**@@**#',
      ':##@@##:',
      ' :####: ',
      '  ::::  ',
      '   ..   ',
    ],
    0.5,
  ),

  // ------------------------------------------------------------- outdoors
  // Trees are tall and narrow-trunked: at this resolution the silhouette is
  // the whole read, so the canopy needs a ragged edge rather than a neat oval.
  tree: def('tree', [104, 150, 84], 2.2, 3.4, 0, [
    '  .:##:.  ',
    ' :######: ',
    '.########.',
    '##########',
    '##########',
    '.########.',
    ' :######: ',
    '.:######:.',
    '  .:##:.  ',
    '   :##:   ',
    '    ##    ',
    '    ##    ',
    '   .##.   ',
    '   ####   ',
  ]),

  pine: def('pine', [72, 118, 82], 1.7, 4.0, 0, [
    '    ##    ',
    '   :##:   ',
    '   ####   ',
    '  .####.  ',
    '  ::##::  ',
    '  ######  ',
    ' .######. ',
    ' ::####:: ',
    ' ######## ',
    '.########.',
    ':::####:::',
    '   .##.   ',
    '    ##    ',
    '   ####   ',
  ]),

  shrub: def('shrub', [110, 138, 78], 1.0, 0.7, 0, [
    ' .:##:. ',
    '.######.',
    '########',
    '########',
    '.######.',
    ' :####: ',
    '  :##:  ',
  ]),

  reeds: def('reeds', [138, 148, 92], 1.0, 1.2, 0, [
    '. .  . .',
    '#.#  #.#',
    '#.#..#.#',
    '#.##.#.#',
    '#.##.#.#',
    '#####.##',
    '########',
  ]),

  boulder: def('boulder', [142, 138, 128], 1.3, 0.9, 0, [
    '  .:##:.  ',
    ' .######. ',
    '.########.',
    '##########',
    '##########',
    '##########',
    '.########.',
  ]),

  monolith: def('monolith', [58, 62, 74], 0.5, 1.4, 0, [
    '  ****  ',
    ' :####: ',
    ' ###### ',
    ' ###### ',
    ' ###### ',
    ' ###### ',
    ' ###### ',
    ' ###### ',
    ' ###### ',
    '########',
  ]),
};

export function lookupSprite(id: string | undefined): SpriteDef | null {
  if (!id) return null;
  return SPRITES[id] ?? null;
}

export function spriteIds(): string[] {
  return Object.keys(SPRITES);
}
