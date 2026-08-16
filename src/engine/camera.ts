import type { World } from './world.ts';

export interface MoveInput {
  forward: number; // -1..1
  strafe: number; // -1..1
  turn: number; // -1..1, keyboard turning
  mouseDX: number; // radians, consumed each frame
  mouseDY: number; // rows, consumed each frame
  run: boolean;
}

const WALK_SPEED = 2.6;
const RUN_MULTIPLIER = 1.9;
const TURN_SPEED = 2.3; // radians/sec
const RADIUS = 0.24;

export class Camera {
  x = 1.5;
  y = 1.5;
  angle = 0;

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

  placeAt(x: number, y: number, angle: number): void {
    this.x = x;
    this.y = y;
    this.angle = angle;
    this.pitch = 0;
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

    const speed = WALK_SPEED * (input.run ? RUN_MULTIPLIER : 1) * dt;
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

      if (world.canOccupy(this.x + mx, this.y, RADIUS)) this.x += mx;
      if (world.canOccupy(this.x, this.y + my, RADIUS)) this.y += my;
    }
  }
}
