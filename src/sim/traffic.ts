/** A stop sign or traffic signal that applies to the route. */
export interface TrafficControl {
  id: number;
  kind: 'traffic_signals' | 'stop';
  /** Distance along the route of the stop line, m. */
  s: number;
}

export type SignalState = 'green' | 'yellow' | 'red';

/** Fixed-time signal plan: 25 s green, 4 s yellow, 25 s red, offset per signal. */
export const SIGNAL_CYCLE = 54;

export function signalState(id: number, time: number): SignalState {
  const t = (((time + (id % SIGNAL_CYCLE)) % SIGNAL_CYCLE) + SIGNAL_CYCLE) % SIGNAL_CYCLE;
  return t < 25 ? 'green' : t < 29 ? 'yellow' : 'red';
}
