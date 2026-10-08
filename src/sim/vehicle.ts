import { DrivePath } from '../geo/path';
import { clamp, wrapPi } from '../geo/geo';
import { Gear, Transmission } from './transmission';

export interface VehicleControls {
  /** 0..1 */
  throttle: number;
  /** 0..1 */
  brake: number;
  /** -1 (full left) .. 1 (full right) */
  steer: number;
  /** Racing wheels map 1:1 to the road wheels; sticks and keys get speed-sensitive steering. */
  steerIsAbsolute: boolean;
}

export type SteeringAssist = 'off' | 'curves' | 'lane';

export interface VehicleParams {
  mass: number; // kg
  wheelbase: number; // m
  maxSteer: number; // rad at the road wheels
  maxPower: number; // W
  maxTractionForce: number; // N
  maxBrakeForce: number; // N
  dragCoefficient: number; // N per (m/s)^2
  rollingResistance: number; // N
  creepSpeed: number; // m/s an automatic idles to in D/R
  creepForce: number; // N
  maxReverseSpeed: number; // m/s
  /** Half-width of the drivable road surface either side of the centre line. */
  roadHalfWidth: number;
  /** Lateral lane centre (positive = right of centre line). */
  laneCenter: number;
}

export const DEFAULT_PARAMS: VehicleParams = {
  mass: 1500,
  wheelbase: 2.7,
  maxSteer: (35 * Math.PI) / 180,
  maxPower: 95_000,
  maxTractionForce: 6500,
  maxBrakeForce: 11_500,
  dragCoefficient: 0.42,
  rollingResistance: 180,
  creepSpeed: 2.2,
  creepForce: 900,
  maxReverseSpeed: 7,
  roadHalfWidth: 6,
  laneCenter: 1.8,
};

/** Internal ratios used only for the tachometer and engine sound. */
const GEAR_RATIOS = [3.6, 2.15, 1.45, 1.05, 0.82, 0.67];
const FINAL_DRIVE = 3.7;
const WHEEL_RADIUS = 0.32;
const IDLE_RPM = 750;
const REDLINE_RPM = 6500;

export interface VehicleState {
  /** Distance along the path, m. */
  s: number;
  /** Lateral offset from the centre line, m (positive = right). */
  d: number;
  /** Heading relative to the road, rad (positive = pointing right). */
  psi: number;
  /** Signed longitudinal speed, m/s. */
  speed: number;
  /** Longitudinal acceleration of the last step, m/s^2. */
  accel: number;
  /** Lateral acceleration of the last step, m/s^2. */
  lateralAccel: number;
  /** Road-wheel steering angle, rad. */
  steerAngle: number;
  /** World yaw rate, rad/s. */
  yawRate: number;
  rpm: number;
  /** Internal automatic gear 1..6, for display. */
  autoGear: number;
  /** True while the car is scraping the road edge. */
  offRoad: boolean;
}

/**
 * A kinematic bicycle model expressed in the road's Frenet frame. Position is
 * (s, d) along the route, so the car always stays on roads that have imagery,
 * but road curvature feeds back into heading: without steering input the car
 * drifts wide in every bend, exactly like a real one.
 */
export class Vehicle {
  readonly transmission = new Transmission();
  state: VehicleState;
  assist: SteeringAssist = 'curves';

  constructor(
    readonly path: DrivePath,
    readonly params: VehicleParams = DEFAULT_PARAMS,
  ) {
    this.state = Vehicle.initialState(params);
  }

  static initialState(params: VehicleParams): VehicleState {
    return {
      s: 2,
      d: params.laneCenter,
      psi: 0,
      speed: 0,
      accel: 0,
      lateralAccel: 0,
      steerAngle: 0,
      yawRate: 0,
      rpm: IDLE_RPM,
      autoGear: 1,
      offRoad: false,
    };
  }

  get gear(): Gear {
    return this.transmission.gear;
  }

  reset(): void {
    this.state = Vehicle.initialState(this.params);
    this.transmission.reset();
  }

  /** Advances the simulation. Large frame gaps are split into stable sub-steps. */
  update(controls: VehicleControls, dt: number): void {
    if (!(dt > 0)) return;
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = Math.min(dt, 0.25) / steps;
    for (let i = 0; i < steps; i++) this.step(controls, h);
  }

  private step(c: VehicleControls, dt: number): void {
    const p = this.params;
    const st = this.state;
    const gear = this.transmission.gear;
    const v = st.speed;
    const road = this.path.sample(st.s);

    // ---- Longitudinal forces --------------------------------------------
    let drive = 0;
    if (gear === 'D' || gear === 'R') {
      const dir = gear === 'D' ? 1 : -1;
      const along = v * dir; // speed in the selected direction
      const powerLimited = p.maxPower / Math.max(Math.abs(along), 3);
      let force = clamp(c.throttle, 0, 1) * Math.min(p.maxTractionForce, powerLimited);
      // Idle creep: an automatic in gear inches forward with no pedals pressed.
      if (along < p.creepSpeed) force += p.creepForce * clamp(1 - along / p.creepSpeed, 0, 1.5);
      if (gear === 'R' && along > p.maxReverseSpeed) force = 0;
      drive = force * dir;
    }

    const brakeForce = clamp(c.brake, 0, 1) * p.maxBrakeForce + (gear === 'P' ? 1e6 : 0);
    const resist = p.dragCoefficient * v * Math.abs(v) + p.rollingResistance * Math.sign(v);
    // Downhill grade isn't modelled; "resist" plus brakes only ever oppose motion.
    let a = (drive - resist) / p.mass;
    const brakeDecel = brakeForce / p.mass;
    let nextV = v + a * dt;
    if (v !== 0 || Math.abs(drive) > 0) {
      // Apply braking toward zero without overshooting into the other direction.
      const sign = Math.sign(nextV) || Math.sign(v);
      const braked = nextV - sign * brakeDecel * dt;
      nextV = Math.sign(braked) !== sign ? 0 : braked;
    }
    // Static friction: brakes and rolling resistance hold a stopped car.
    if (Math.abs(nextV) < 0.02 && Math.abs(drive) <= brakeForce + p.rollingResistance) nextV = 0;
    if (gear === 'P') nextV = 0;
    a = (nextV - v) / dt;

    // ---- Steering ------------------------------------------------------
    let steerInput = clamp(c.steer, -1, 1);
    if (!c.steerIsAbsolute) {
      // Sticks and keys have short travel: reduce authority at speed so a
      // full deflection on the highway doesn't spin the car.
      steerInput /= 1 + (Math.abs(nextV) / 14) ** 2;
    }
    let delta = steerInput * p.maxSteer;
    if (this.assist !== 'off') {
      // Feed-forward: the angle that would exactly follow the road's curve.
      const pathCurvature = road.curvature / Math.max(0.2, 1 - road.curvature * st.d);
      delta += Math.atan(p.wheelbase * pathCurvature) * Math.cos(st.psi);
      // Gentle self-centring toward the road direction, like caster on a real car.
      delta -= st.psi * 0.3;
      if (this.assist === 'lane') {
        const lookahead = Math.max(6, Math.abs(nextV) * 1.2);
        const err = st.d - p.laneCenter;
        delta += -Math.atan2(err, lookahead) - st.psi * 0.8;
      }
    }
    delta = clamp(delta, -p.maxSteer, p.maxSteer);
    st.steerAngle = delta;

    // ---- Frenet kinematics ---------------------------------------------
    const omega = (nextV * Math.tan(delta)) / p.wheelbase;
    const denom = Math.max(0.2, 1 - road.curvature * st.d);
    const ds = (nextV * Math.cos(st.psi)) / denom;
    st.s += ds * dt;
    st.d += nextV * Math.sin(st.psi) * dt;
    st.psi = wrapPi(st.psi + (omega - road.curvature * ds) * dt);
    st.yawRate = omega;

    // Road edges behave like a curb: the car scrapes along it and slows down.
    st.offRoad = false;
    if (Math.abs(st.d) > p.roadHalfWidth) {
      st.offRoad = true;
      st.d = clamp(st.d, -p.roadHalfWidth, p.roadHalfWidth);
      st.psi *= 0.5;
      nextV *= 1 - clamp(2.5 * dt, 0, 1);
    }
    // Keep the car from spinning around on a route-constrained road.
    st.psi = clamp(st.psi, -1.2, 1.2);

    if (st.s < 0) {
      st.s = 0;
      nextV = Math.max(0, nextV);
    }
    if (st.s > this.path.length) {
      st.s = this.path.length;
      nextV = Math.min(0, nextV);
    }

    st.accel = a;
    st.lateralAccel = nextV * omega;
    st.speed = nextV;
    this.updateEngine(c, gear);
  }

  private updateEngine(c: VehicleControls, gear: Gear): void {
    const st = this.state;
    const wheelRpm = (Math.abs(st.speed) / WHEEL_RADIUS) * (60 / (2 * Math.PI));
    if (gear === 'D') {
      // Shift points rise with throttle, like a real automatic's shift map.
      const upAt = 1900 + 2800 * c.throttle;
      const downAt = 1100 + 1200 * c.throttle;
      const rpmIn = (g: number) => wheelRpm * GEAR_RATIOS[g - 1] * FINAL_DRIVE;
      if (st.autoGear < GEAR_RATIOS.length && rpmIn(st.autoGear) > upAt) st.autoGear++;
      else if (st.autoGear > 1 && rpmIn(st.autoGear - 1) < downAt + 400) st.autoGear--;
    } else {
      st.autoGear = 1;
    }
    const target =
      gear === 'D' || gear === 'R'
        ? Math.max(
            IDLE_RPM + 400 * c.throttle,
            wheelRpm * GEAR_RATIOS[st.autoGear - 1] * FINAL_DRIVE,
          )
        : IDLE_RPM + c.throttle * 4800; // free revving in P or N
    st.rpm += (Math.min(target, REDLINE_RPM) - st.rpm) * 0.15;
  }

  /** World pose of the car for rendering. Heading is a compass angle in radians. */
  pose(): { x: number; y: number; heading: number } {
    const w = this.path.toWorld(this.state.s, this.state.d);
    return { x: w.x, y: w.y, heading: w.heading + this.state.psi };
  }
}

export const MPS_TO_MPH = 2.236936;
export const MPS_TO_KPH = 3.6;
