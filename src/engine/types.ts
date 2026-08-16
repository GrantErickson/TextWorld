/** Shared value types for the world model and renderer. */

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export type PatternId =
  | 'solid'
  | 'noise'
  | 'rock'
  | 'brick'
  | 'panel'
  | 'grate'
  | 'tile'
  | 'planks';

export interface Material {
  id: string;
  color: RGB;
  pattern: PatternId;
  /** Scales how strongly the pattern modulates brightness. 0 = flat, 1 = full. */
  roughness: number;
  /** Self-illumination, added on top of scene lighting. */
  emissive: number;
}

export const TILE_EMPTY = 0;
export const TILE_WALL = 1;
export const TILE_DOOR = 2;
export type TileType = typeof TILE_EMPTY | typeof TILE_WALL | typeof TILE_DOOR;

export interface Tile {
  type: TileType;
  /** Wall surface material; null for open tiles. */
  wall: Material | null;
  floor: Material;
  ceiling: Material;
  /** Open to the sky: the ceiling is not drawn, the sky is. */
  sky: boolean;
  /** Index into World.doors, or -1. */
  doorId: number;
  /** Baked ambient occlusion for the floor/ceiling of this tile, 0..1. */
  ao: number;

  // ------------------------------------------------- outdoor worlds only
  /**
   * Elevation of this tile's top surface, in tiles. Always 0 for indoor maps,
   * which keeps the flat-floor renderer exactly as it was.
   */
  height: number;
  /** Surface normal, baked from neighbouring heights. Drives the sun term. */
  nx: number;
  ny: number;
  nz: number;
  /** Shallow water: walkable, but shaded and textured as a river surface. */
  water: boolean;
  /** Material of the vertical face where this tile steps up from its neighbour. */
  side: Material | null;
  /** Cleared ground — road, yard, riverbed. Nothing is scattered on it. */
  bare: boolean;
  /** Index into the theme's biome list; selects what grows here. */
  biome: number;
}

export interface Door {
  id: number;
  tx: number;
  ty: number;
  /**
   * 'x' -> the panel spans the cell's X range and sits on the plane y = ty + 0.5
   *        (you walk through it heading north/south).
   * 'y' -> the panel spans the cell's Y range on the plane x = tx + 0.5.
   */
  axis: 'x' | 'y';
  material: Material;
  /** 0 = fully closed, 1 = fully retracted into the frame. */
  openness: number;
  target: number;
  /** Opens by itself when the player is near. */
  auto: boolean;
  /** Seconds an auto door stays open after the player leaves. */
  holdTimer: number;
  speed: number;
}

export interface Light {
  x: number;
  y: number;
  radius: number;
  color: RGB;
  intensity: number;
  /** 0..1 amount of pseudo-random brightness wobble. */
  flicker: number;
  seed: number;
  /**
   * Per-tile visibility from this light, 0..1, recomputed lazily. The field
   * covers only the light's own reach — a window of visW x visH tiles whose
   * top-left tile is (visOX, visOY) — rather than the whole map. A light can
   * illuminate nothing beyond its radius, so baking the rest is wasted work,
   * and on a streamed world the map has no fixed size to bake over anyway.
   */
  vis: Float32Array | null;
  visDirty: boolean;
  visOX: number;
  visOY: number;
  visW: number;
  visH: number;
  /** World position the visibility field was last baked from. */
  visX: number;
  visY: number;
  /** Set for lights carried by an entity. */
  ownerEntity: number;
  cooldown: number;
}

export interface SpriteDef {
  id: string;
  color: RGB;
  emissive: number;
  /**
   * Density art. ' ' is transparent; '.' ':' '+' '*' '#' ramp from faint to
   * solid; '@' is solid and self-lit.
   */
  art: string[];
  /** World-space width and height in tiles. */
  width: number;
  height: number;
  /** Height of the sprite's bottom edge above the floor, in tiles. */
  base: number;
}

export interface Entity {
  index: number;
  def: SpriteDef;
  x: number;
  y: number;
  /** Ground elevation the sprite stands on. 0 for indoor maps. */
  z: number;
  /**
   * Overrides the sprite definition's colour. Sprite art carries one palette,
   * but the same shrub should be sage in a desert and deep green in a forest,
   * and drawing a second set of art per biome is a poor trade for a tint.
   */
  tint: RGB | null;
  /** Waypoint loop in world coordinates; empty for static props. */
  path: Array<[number, number]>;
  pathIndex: number;
  speed: number;
  /** Vertical bob, purely cosmetic, in tiles. */
  bob: number;
  bobPhase: number;
  lightIndex: number;
}
