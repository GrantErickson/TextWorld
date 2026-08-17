import type { World } from './world.ts';

export interface MoveInput {
  forward: number; // -1..1
  strafe: number; // -1..1
  turn: number; // -1..1, keyboard turning
  mouseDX: number; // radians, consumed each frame
  mouseDY: number; // rows, consumed each frame
  run: boolean;
  jump: boolean;
  /** -1..1 vertical intent, used while flying. */
  lift: number;
}

const WALK_SPEED = 2.6;
const RUN_MULTIPLIER = 1.9;
const TURN_SPEED = 2.3; // radians/sec
const RADIUS = 0.24;

/** Eye height above whatever the feet are standing on, in tiles. */
export const EYE_HEIGHT = 0.5;
/**
 * How fast the eye catches up to the ground beneath it. Stepping onto a ledge
 * should not teleport the view, and the smoothing costs nothing in stability:
 * it settles within a few frames and then stops moving entirely.
 */
const EYE_FOLLOW = 14;

const GRAVITY = 18;
/**
 * Chosen so a jump rises a little over one tile. That clears the 0.95-tile
 * terraces of the temperate biomes — enough to scramble out of a hollow — but
 * not the 1.35-tile ledges of the badlands, so a cliff is still a cliff.
 * Anything a jump cannot solve is what flight is for.
 */
const JUMP_SPEED = 6.2;
/** A drop this much below the feet starts a fall rather than a step down. */
const FALL_THRESHOLD = 0.3;
const FLY_SPEED = 6;
/**
 * Indoors the eye must stay between floor and ceiling: the flat-floor passes
 * project both from the eye height, and outside this band the geometry folds
 * through itself.
 */
const INDOOR_MIN_Z = 0.12;
const INDOOR_MAX_Z = 0.88;

/**
 * Water deeper than this stops being something you walk through and starts
 * being something you float in. Set just under the eye, so you go under only
 * at the point where standing would put your head below the surface anyway.
 */
const SWIM_DEPTH = 0.62;
/** How far the eye sits above the water while swimming. */
const SWIM_EYE = 0.16;
/** Speed multipliers for wading and swimming. */
const WADE_SPEED = 0.62;
const SWIM_SPEED = 0.45;
/** How fast the eye settles onto the water when you fall in. */
const SWIM_FOLLOW = 7;

export class Camera {
  x = 1.5;
  y = 1.5;
  angle = 0;

  /**
   * Eye height in world units. On a flat map this stays at EYE_HEIGHT and the
   * renderer behaves exactly as it always did; outdoors it rides the terrain.
   */
  z = EYE_HEIGHT;

  /** Vertical velocity, in tiles per second. Zero unless jumping or falling. */
  vz = 0;
  grounded = true;
  /**
   * Free flight. Terrain can and does produce hollows that a jump cannot get
   * out of, and rather than compromise the landscape to guarantee escape, this
   * is the way out. It also happens to be the best way to look at a landscape.
   */
  flying = false;

  /** Standing in water shallow enough to walk through. */
  wading = false;
  /** Afloat: the water here is over your head, so the feet leave the bed. */
  swimming = false;

  /** Vertical look, in screen rows offset from centre. */
  pitch = 0;

  dirX = 1;
  dirY = 0;
  planeX = 0;
  planeY = 1;

  /** Horizontal field of view, radians. */
  fov = (72 * Math.PI) / 180;

  /** Half-width of the camera plane; the projection's only tuning knob. */
  planeLength = Math.tan(this.fov / 2);

  /** Set when the camera jumps, so the renderer can drop its history. */
  teleported = true;

  setFov(radians: number): void {
    this.fov = radians;
    this.planeLength = Math.tan(radians / 2);
    this.updateBasis();
  }

  placeAt(x: number, y: number, angle: number, groundZ = 0, eye = EYE_HEIGHT): void {
    this.x = x;
    this.y = y;
    this.angle = angle;
    this.z = groundZ + eye;
    this.pitch = 0;
    this.vz = 0;
    this.grounded = true;
    this.wading = false;
    this.swimming = false;
    this.teleported = true;
    this.updateBasis();
  }

  updateBasis(): void {
    this.dirX = Math.cos(this.angle);
    this.dirY = Math.sin(this.angle);
    // Plane is the left-hand perpendicular scaled to the half-FOV.
    this.planeX = -this.dirY * this.planeLength;
    this.planeY = this.dirX * this.planeLength;
  }

  /**
   * Advance the camera. Movement is resolved one axis at a time so that
   * walking into a wall at an angle slides along it rather than stopping dead.
   *
   * There is deliberately no head bob or view sway here. Both are cheap ways
   * to make a pixel renderer feel alive and both are poison at this
   * resolution: they add continuous sub-cell motion that no amount of
   * hysteresis can settle, so the image would never come to rest.
   */
  update(dt: number, input: MoveInput, world: World, maxRows: number): void {
    if (input.turn !== 0) this.angle += input.turn * TURN_SPEED * dt;
    if (input.mouseDX !== 0) this.angle += input.mouseDX;

    if (this.angle > Math.PI) this.angle -= Math.PI * 2;
    else if (this.angle < -Math.PI) this.angle += Math.PI * 2;

    if (input.mouseDY !== 0) this.pitch += input.mouseDY;
    const pitchLimit = maxRows * 0.32;
    this.pitch = Math.max(-pitchLimit, Math.min(pitchLimit, this.pitch));

    this.updateBasis();

    const drag = this.flying ? 1 : this.swimming ? SWIM_SPEED : this.wading ? WADE_SPEED : 1;
    const speed = WALK_SPEED * (input.run ? RUN_MULTIPLIER : 1) * drag * dt;
    let mx = 0;
    let my = 0;
    if (input.forward !== 0) {
      mx += this.dirX * input.forward;
      my += this.dirY * input.forward;
    }
    if (input.strafe !== 0) {
      // Strafe along the camera plane, normalised so FOV does not change pace.
      mx += (this.planeX / this.planeLength) * input.strafe;
      my += (this.planeY / this.planeLength) * input.strafe;
    }

    const len = Math.hypot(mx, my);
    if (len > 1e-6) {
      mx = (mx / len) * speed;
      my = (my / len) * speed;

      // Outdoors the same call refuses steps the legs could not make, so a
      // cliff stops you without being modelled as a wall. Passing the feet
      // height means that while airborne you clear whatever you are above —
      // jumping onto a ledge works, and walking into its face still does not.
      const feet = this.z - world.eyeHeight;
      if (world.canStep(this.x, this.y, this.x + mx, this.y, RADIUS, feet)) this.x += mx;
      if (world.canStep(this.x, this.y, this.x, this.y + my, RADIUS, feet)) this.y += my;
    }

    this.updateVertical(dt, input, world);
  }

  /** Gravity, jumping, swimming and flight. */
  private updateVertical(dt: number, input: MoveInput, world: World): void {
    // The bed, not the surface: standing on `groundAt` in a lake would have
    // you walking on the water. Depth is what decides between the two. Passing
    // the feet is what picks a storey out of a column that has several.
    const groundZ = world.bedAt(this.x, this.y, this.z - world.eyeHeight);
    const depth = world.waterDepthAt(this.x, this.y);
    // world.eyeHeight, not the constant: mixing the two puts the eye at one
    // height and reports the feet at another, so the body ends up standing
    // below the ground it is on and every kerb becomes unclimbable.
    const restZ = groundZ + world.eyeHeight;
    const surfaceZ = groundZ + depth;

    // Being *over* deep water is not the same as being *in* it — the eye has
    // to have reached the surface. Without that test you float in mid-air the
    // moment you jump off a cliff above a lake.
    this.swimming = !this.flying && depth > SWIM_DEPTH && this.z <= surfaceZ + SWIM_EYE + 0.05;
    this.wading = !this.flying && !this.swimming && depth > 0.05 && this.z <= surfaceZ + world.eyeHeight;

    if (this.flying) {
      this.vz = 0;
      this.grounded = false;
      this.z += input.lift * FLY_SPEED * dt;
      // Flight is an escape hatch, not a way through the floor.
      if (this.z < restZ) {
        this.z = restZ;
        this.grounded = true;
      }
    } else if (this.swimming) {
      // Afloat. Buoyancy replaces gravity entirely rather than fighting it:
      // a spring settling toward the waterline would bob, and bob is the one
      // thing this renderer cannot have — continuous sub-cell motion that no
      // amount of glyph hysteresis will ever settle.
      const floatZ = groundZ + depth + SWIM_EYE;
      this.vz = 0;
      this.grounded = false;
      const k = Math.min(1, SWIM_FOLLOW * dt);
      this.z += (floatZ - this.z) * k;
      if (Math.abs(floatZ - this.z) < 0.002) this.z = floatZ;
    } else if (this.grounded) {
      if (input.jump) {
        this.vz = JUMP_SPEED;
        this.grounded = false;
        this.z += this.vz * dt;
      } else if (this.z - world.eyeHeight - groundZ > FALL_THRESHOLD) {
        // Walked off a ledge.
        this.grounded = false;
        this.vz = 0;
      } else {
        // Ride the ground, smoothed, so a step up is a rise and not a jolt.
        const k = Math.min(1, EYE_FOLLOW * dt);
        this.z += (restZ - this.z) * k;
        if (Math.abs(restZ - this.z) < 0.002) this.z = restZ;
      }
    } else {
      this.vz -= GRAVITY * dt;
      this.z += this.vz * dt;
      if (this.z <= restZ && this.vz <= 0) {
        this.z = restZ;
        this.vz = 0;
        this.grounded = true;
      }
    }

    if (!world.terrain) {
      // A flat map has a ceiling one tile up; keep the eye inside the room.
      if (this.z > INDOOR_MAX_Z) {
        this.z = INDOOR_MAX_Z;
        if (this.vz > 0) this.vz = 0;
      }
      if (this.z < INDOOR_MIN_Z) this.z = INDOOR_MIN_Z;
    }
  }
}
