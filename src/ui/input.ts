import type { MoveInput } from '../engine/camera.ts';

const MOUSE_YAW = 0.0022; // radians per pixel
const MOUSE_PITCH = 0.06; // screen rows per pixel

/**
 * Keyboard and pointer-lock mouse input.
 *
 * Keys are tracked by `event.code` so the controls stay physically in the same
 * place on non-QWERTY layouts.
 */
export class Input {
  private down = new Set<string>();
  private tapped = new Set<string>();
  private dx = 0;
  private dy = 0;
  private locked = false;

  readonly move: MoveInput = {
    forward: 0,
    strafe: 0,
    turn: 0,
    mouseDX: 0,
    mouseDY: 0,
    run: false,
    jump: false,
    lift: 0,
  };

  onLockChange: ((locked: boolean) => void) | null = null;

  attach(canvas: HTMLCanvasElement): void {
    window.addEventListener('keydown', (e) => {
      // Leave the map editor alone.
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) return;

      if (!this.down.has(e.code)) this.tapped.add(e.code);
      this.down.add(e.code);

      if (
        e.code === 'Space' ||
        e.code === 'ArrowUp' ||
        e.code === 'ArrowDown' ||
        e.code === 'ArrowLeft' ||
        e.code === 'ArrowRight'
      ) {
        e.preventDefault();
      }
    });

    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => {
      this.down.clear();
      this.dx = 0;
      this.dy = 0;
    });

    canvas.addEventListener('click', () => {
      if (!this.locked) void canvas.requestPointerLock();
    });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked) {
        this.dx = 0;
        this.dy = 0;
      }
      this.onLockChange?.(this.locked);
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.dx += e.movementX;
      this.dy += e.movementY;
    });
  }

  isLocked(): boolean {
    return this.locked;
  }

  /** True once per physical key press. */
  wasTapped(code: string): boolean {
    return this.tapped.has(code);
  }

  /** Build this frame's movement intent and clear one-shot state. */
  sample(): MoveInput {
    const m = this.move;
    m.forward = 0;
    m.strafe = 0;
    m.turn = 0;

    if (this.down.has('KeyW') || this.down.has('ArrowUp')) m.forward += 1;
    if (this.down.has('KeyS') || this.down.has('ArrowDown')) m.forward -= 1;
    if (this.down.has('KeyD')) m.strafe += 1;
    if (this.down.has('KeyA')) m.strafe -= 1;
    if (this.down.has('ArrowRight')) m.turn += 1;
    if (this.down.has('ArrowLeft')) m.turn -= 1;

    m.run = this.down.has('ShiftLeft') || this.down.has('ShiftRight');

    // Space both jumps and, while flying, climbs; holding it does the sensible
    // thing in either case.
    const rise = this.down.has('Space');
    const sink = this.down.has('ControlLeft') || this.down.has('ControlRight') || this.down.has('KeyC');
    m.jump = rise;
    m.lift = (rise ? 1 : 0) - (sink ? 1 : 0);

    m.mouseDX = this.dx * MOUSE_YAW;
    m.mouseDY = this.dy * MOUSE_PITCH;
    this.dx = 0;
    this.dy = 0;

    return m;
  }

  endFrame(): void {
    this.tapped.clear();
  }
}
