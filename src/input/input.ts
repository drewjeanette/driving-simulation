import { GamepadInput } from './gamepad';
import { KeyboardInput } from './keyboard';
import { InputFrame, emptyFrame } from './types';

export interface TouchState {
  throttle: number;
  brake: number;
  steer: number;
}

/** Merges keyboard, controllers and touch into one InputFrame per animation frame. */
export class InputManager {
  readonly keyboard = new KeyboardInput();
  readonly gamepads = new GamepadInput();
  /** Set by on-screen touch controls on phones and tablets. */
  touch: TouchState | null = null;
  private lastDevice: InputFrame['device'] = 'keyboard';

  poll(dt: number): InputFrame {
    const frame = emptyFrame();
    this.gamepads.poll(frame);
    if (this.touch) {
      frame.throttle = Math.max(frame.throttle, this.touch.throttle);
      frame.brake = Math.max(frame.brake, this.touch.brake);
      if (Math.abs(this.touch.steer) > Math.abs(frame.steer)) frame.steer = this.touch.steer;
    }
    const padDevice = frame.device;
    const before = frame.throttle + frame.brake + Math.abs(frame.steer);
    this.keyboard.poll(frame, dt);
    const after = frame.throttle + frame.brake + Math.abs(frame.steer);
    if (padDevice !== 'keyboard') this.lastDevice = padDevice;
    else if (after > before) this.lastDevice = 'keyboard';
    frame.device = this.lastDevice;
    return frame;
  }
}
