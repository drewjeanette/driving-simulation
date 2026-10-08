import * as THREE from 'three';
import { DrivePath } from '../geo/path';
import { damp } from '../geo/geo';
import { Cockpit } from './cockpit';
import { StreetViewLayer } from './streetview';
import { buildSky, buildWorld } from './world';

export type CameraView = 'cockpit' | 'clean';

const EYE_HEIGHT = 1.2;

export interface PoseInput {
  x: number;
  y: number;
  heading: number;
  speed: number;
  accel: number;
  yawRate: number;
  steerAngle: number;
}

/**
 * Owns the WebGL renderer, scene graph and camera rig:
 *   rig (car pose) -> recenter (VR seat offset) -> head (desktop look) -> camera
 * The same graph renders on a monitor and, through WebXR, in a headset where
 * the camera follows real head movement inside the car.
 */
export class DriveRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(72, 1, 0.05, 5000);
  readonly cockpit: Cockpit;
  private readonly rig = new THREE.Group();
  private readonly recenter = new THREE.Group();
  private readonly head = new THREE.Group();
  private readonly world: THREE.Group;
  private readonly ground: THREE.Object3D | undefined;
  private readonly resizeObserver: ResizeObserver;
  private lookYaw = 0;
  private lookPitch = 0;
  private dynamicPitch = 0;
  private dynamicYaw = 0;
  private bobPhase = 0;
  view: CameraView = 'cockpit';
  onXRChange?: (active: boolean) => void;

  constructor(
    private readonly container: HTMLElement,
    path: DrivePath,
    rightHandTraffic: boolean,
    readonly streetView: StreetViewLayer | null,
  ) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType('local');
    this.renderer.domElement.className = 'drive-canvas';
    container.prepend(this.renderer.domElement);

    this.scene.background = new THREE.Color('#cfe0f0');
    this.scene.fog = new THREE.Fog('#d6e4f0', 180, 1400);
    this.scene.add(new THREE.HemisphereLight('#e8f1ff', '#5d6b45', 1.6));
    const sun = new THREE.DirectionalLight('#fff4e0', 2.2);
    sun.position.set(300, 500, -400);
    this.scene.add(sun);
    this.scene.add(buildSky());

    this.world = buildWorld(path, rightHandTraffic);
    this.ground = this.world.getObjectByName('ground');
    this.scene.add(this.world);
    if (streetView) {
      streetView.maxTextureSize = this.renderer.capabilities.maxTextureSize;
      this.scene.add(streetView.mesh);
    }

    this.cockpit = new Cockpit(rightHandTraffic ? -1 : 1);
    this.scene.add(this.rig);
    this.rig.add(this.recenter);
    this.recenter.add(this.head);
    this.head.add(this.camera);
    this.recenter.add(this.cockpit.group);
    this.recenter.position.y = EYE_HEIGHT;

    this.renderer.xr.addEventListener('sessionstart', () => {
      this.cockpit.navPanel.visible = true;
      this.onXRChange?.(true);
    });
    this.renderer.xr.addEventListener('sessionend', () => {
      this.cockpit.navPanel.visible = false;
      this.recenter.rotation.set(0, 0, 0);
      this.recenter.position.set(0, EYE_HEIGHT, 0);
      this.onXRChange?.(false);
    });

    // Over real Street View photos an unobstructed view looks best; the
    // modelled cockpit is one press of the camera button away.
    this.setView(streetView ? 'clean' : 'cockpit');

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
  }

  get inXR(): boolean {
    return this.renderer.xr.isPresenting;
  }

  setView(view: CameraView): void {
    this.view = view;
    this.cockpit.group.visible = view === 'cockpit';
  }

  /** Desktop look-around from mouse drag or a right stick, in radians. */
  setLook(yaw: number, pitch: number): void {
    this.lookYaw = yaw;
    this.lookPitch = pitch;
  }

  update(p: PoseInput, dt: number): void {
    this.rig.position.set(p.x, 0, -p.y);
    this.rig.rotation.y = -p.heading;
    this.cockpit.setSteer(p.steerAngle);
    if (this.ground) this.ground.position.set(p.x, -0.05, -p.y);

    // Small, damped body motion sells speed: the nose dips under braking,
    // eyes lead into turns and the road surface adds a faint vibration.
    const speed = Math.abs(p.speed);
    this.dynamicPitch = damp(this.dynamicPitch, -p.accel * 0.006, 4, dt);
    this.dynamicYaw = damp(this.dynamicYaw, -p.yawRate * 0.18, 3, dt);
    this.bobPhase += dt * (6 + speed * 0.9);
    const bob = Math.min(speed / 25, 1) * 0.004;

    if (this.inXR) {
      this.head.rotation.set(0, 0, 0);
      this.head.position.set(0, 0, 0);
    } else {
      this.head.rotation.set(
        this.lookPitch + this.dynamicPitch,
        this.lookYaw + this.dynamicYaw,
        0,
        'YXZ',
      );
      this.head.position.set(
        0,
        Math.sin(this.bobPhase) * bob + (this.view === 'clean' ? 0.2 : 0),
        this.view === 'clean' ? -0.6 : 0,
      );
    }

    // Skip drawing the simulated world while Street View fully covers it.
    if (this.streetView) this.world.visible = this.streetView.coverage < 0.99;
  }

  updateStreetView(s: number, dt: number, speed = 0): void {
    if (!this.streetView) return;
    const eye = new THREE.Vector3();
    this.camera.getWorldPosition(eye);
    this.streetView.update(s, eye, dt, speed);
  }

  /** Re-aligns the VR seat so wherever the player is looking becomes straight ahead. */
  recenterVR(): void {
    if (!this.inXR) return;
    const xrCam = this.renderer.xr.getCamera();
    const headWorld = new THREE.Vector3();
    xrCam.getWorldPosition(headWorld);
    const local = this.rig.worldToLocal(headWorld.clone());
    const q = new THREE.Quaternion();
    xrCam.getWorldQuaternion(q);
    const worldYaw = new THREE.Euler().setFromQuaternion(q, 'YXZ').y;
    const headYaw = worldYaw - this.rig.rotation.y - this.recenter.rotation.y;
    this.recenter.rotation.y -= headYaw;
    this.recenter.position.x -= local.x;
    this.recenter.position.z -= local.z;
    this.recenter.position.y += EYE_HEIGHT - local.y;
  }

  async enterVR(): Promise<void> {
    if (!navigator.xr) throw new Error('WebXR is not available in this browser.');
    const session = await navigator.xr.requestSession('immersive-vr', {
      optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'],
    });
    await this.renderer.xr.setSession(session);
  }

  async exitVR(): Promise<void> {
    await this.renderer.xr.getSession()?.end();
  }

  static async vrSupported(): Promise<boolean> {
    try {
      return !!navigator.xr && (await navigator.xr.isSessionSupported('immersive-vr'));
    } catch {
      return false;
    }
  }

  start(frame: (dt: number) => void): void {
    const timer = new THREE.Timer();
    this.renderer.setAnimationLoop((time) => {
      timer.update(time);
      const dt = Math.min(timer.getDelta(), 0.1);
      if (dt > 0) frame(dt);
      this.renderer.render(this.scene, this.camera);
    });
  }

  private resize(): void {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    if (this.inXR) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Keep a sensible horizontal field of view on tall phone screens.
    this.camera.fov = w / h < 1 ? 90 : 72;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.streetView?.dispose();
    this.cockpit.dispose();
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.InstancedMesh) {
        o.geometry.dispose();
        const m = o.material as THREE.Material | THREE.Material[];
        (Array.isArray(m) ? m : [m]).forEach((x) => {
          (x as THREE.MeshLambertMaterial).map?.dispose();
          x.dispose();
        });
      }
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
