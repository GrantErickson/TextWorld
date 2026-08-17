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
  | 'planks'
  | 'water';

export interface Material {
  id: string;
  color: RGB;
  pattern: PatternId;
  /** Scales how strongly the pattern modulates brightness. 0 = flat, 1 = full. */
  roughness: number;
  /** Self-illumination, added on top of scene lighting. */
  emissive: number;
  /**
   * Extra self-illumination that only appears as it gets dark, scaled by the
   * world's `windowGlow`. Lit windows and neon are the whole character of a
   * city at night, and doing them with real lights would blow the light budget
   * many times over — glow costs nothing because it never illuminates anything
   * but itself.
   */
  nightGlow: number;
  /**
   * Which glyph ramp draws this surface in `material` mode. Derived from the
   * pattern once, here, so the renderer never does a string compare per cell.
   */
  glyphSlot: number;
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
   * Elevation of this tile's *visible* top surface, in tiles: the water
   * surface where there is water, the ground everywhere else. Always 0 for
   * indoor maps, which keeps the flat-floor renderer exactly as it was.
   */
  height: number;
  /**
   * Elevation of the solid ground, under any water. Equal to `height` on dry
   * land. Movement reads this and rendering reads `height`, which is the whole
   * reason a lake can be level over a bed that is not.
   */
  bed: number;
  /** `height - bed`. 0 on dry land; drives the water's colour and swimming. */
  depth: number;
  /** Surface normal, baked from neighbouring heights. Drives the sun term. */
  nx: number;
  ny: number;
  nz: number;
  /** Standing water: this tile's top surface is a water surface. */
  water: boolean;
  /** Material of the vertical face where this tile steps up from its neighbour. */
  side: Material | null;
  /**
   * Material for the *lower* part of that face, below `bandZ` — a shopfront
   * under the storeys above it. A facade in one material from pavement to
   * roof is what makes a building read as an extruded block rather than as
   * something with a ground floor.
   */
  sideLower: Material | null;
  /** Absolute height below which `sideLower` is used. */
  bandZ: number;
  /** Cleared ground — road, yard, riverbed. Nothing is scattered on it. */
  bare: boolean;
  /** Index into the theme's biome list; selects what grows here. */
  biome: number;

  // ---------------------------------------------------- city worlds only
  /**
   * Storeys in the building occupying this tile, or 0 for open ground. Held
   * per tile rather than as a list of spans: a building column is regular —
   * a slab every STOREY up to the roof — so the spans can be derived from
   * this and the tile stays small enough to rebuild a whole window cheaply.
   */
  storeys: number;
  /** Inside a building's footprint rather than on its wall. */
  interior: boolean;
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
  /**
   * Height above the world's zero, in tiles. A lamp on a post and a candle on
   * a floor pool very differently, and outdoors the difference is the whole
   * character of the light.
   */
  z: number;
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
  /**
   * Full-strength intensity for a light that answers to the clock — a street
   * lamp or a lit window. 0 for lights that burn regardless. Keeping the
   * daylit value here means the time of day can dim it without the renderer
   * knowing anything about time.
   */
  lampBase: number;
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
  /**
   * Art seen end-on, for anything with a heading. A billboard is right for a
   * roughly symmetric object like a tree, and wrong for a bus: swinging its
   * long side to face you wherever you stand is the single most cardboard
   * thing a sprite can do. Sprites with this are drawn from whichever of the
   * two views the viewer is actually nearer to.
   */
  endArt?: string[];
  /** World width of the end-on view; the long view keeps `width`. */
  endWidth?: number;
  /**
   * Self-illumination for the '@' cells that only appears after dark, scaled
   * by the world's `windowGlow`. Headlights on all afternoon look broken, and
   * a real light per car would empty the light budget in a single street.
   */
  nightGlow?: number;
  /**
   * Apply an entity's tint only to the self-lit ('@') cells. A traffic signal
   * needs its lamp to change colour without its post changing with it.
   */
  tintLitOnly?: boolean;
  /** Which glyph ramp draws this sprite in `material` mode. */
  glyphSlot: number;
}

/** Entities that just stand there, and entities that go somewhere. */
export const ACTOR_PROP = 0;
export const ACTOR_CAR = 1;
export const ACTOR_PERSON = 2;

export interface Entity {
  index: number;
  def: SpriteDef;
  /**
   * What drives this entity. Props are regenerated from the map every time the
   * window moves, since they are a pure function of position; actors are
   * carried across, because a car that teleported back to its lattice position
   * every few seconds of walking would be worse than no traffic at all.
   */
  kind: number;
  /** Heading, for actors. Axis-aligned for anything on a street. */
  dirX: number;
  dirY: number;
  /** Speed this actor would travel at with nothing in its way. */
  cruise: number;
  /**
   * Seconds left on whatever this actor is currently doing: a bus waiting at
   * a stop, or a pedestrian part-way across a road. Actors are otherwise
   * stateless, and both of those need to outlast a single frame.
   */
  timer: number;
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
  /**
   * Horizontal lean, in tiles, applied as a shear so the top of the sprite
   * moves and its base does not. Trees that slide bodily sideways read as
   * sliding; the pivot at the foot is what makes it look like wind.
   */
  sway: number;
  lightIndex: number;
}
