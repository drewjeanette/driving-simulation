export type Action =
  | 'shiftUp'
  | 'shiftDown'
  | 'gearP'
  | 'gearR'
  | 'gearN'
  | 'gearD'
  | 'signalLeft'
  | 'signalRight'
  | 'hazards'
  | 'horn'
  | 'camera'
  | 'pause'
  | 'recenter';

export const ACTION_LABELS: Record<Action, string> = {
  shiftUp: 'Shift up (toward P)',
  shiftDown: 'Shift down (toward D)',
  gearP: 'Park',
  gearR: 'Reverse',
  gearN: 'Neutral',
  gearD: 'Drive',
  signalLeft: 'Left turn signal',
  signalRight: 'Right turn signal',
  hazards: 'Hazard lights',
  horn: 'Horn',
  camera: 'Change camera',
  pause: 'Pause',
  recenter: 'Recenter view',
};

export interface InputFrame {
  throttle: number;
  brake: number;
  steer: number;
  /** True when steering comes from a wheel that maps 1:1 to the road wheels. */
  steerIsAbsolute: boolean;
  /** Look offsets from a right stick, -1..1. */
  lookX: number;
  lookY: number;
  horn: boolean;
  /** Actions pressed this frame (rising edges), in order. Repeats are kept. */
  actions: Action[];
  /** Which device produced the analog input most recently. */
  device: 'keyboard' | 'gamepad' | 'wheel';
}

export function emptyFrame(): InputFrame {
  return {
    throttle: 0,
    brake: 0,
    steer: 0,
    steerIsAbsolute: false,
    lookX: 0,
    lookY: 0,
    horn: false,
    actions: [],
    device: 'keyboard',
  };
}
