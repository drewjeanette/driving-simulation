import * as THREE from 'three';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { TilesRenderer } from '3d-tiles-renderer';
import {
  GLTFExtensionsPlugin,
  GoogleCloudAuthPlugin,
  ReorientationPlugin,
  TileCompressionPlugin,
  TilesFadePlugin,
} from '3d-tiles-renderer/plugins';
import { LatLng, toRad } from '../geo/geo';

/** Google hosts the Draco mesh decoder that its 3D tiles are compressed with. */
const DRACO_DECODERS = 'https://www.gstatic.com/draco/versioned/decoders/1.5.7/';

/**
 * Google Photorealistic 3D Tiles: the textured 3D buildings, trees and
 * terrain shown in Google Maps' 3D view, streamed around the car.
 *
 * The tileset is re-oriented so the route's start is the origin with +Y up,
 * then rotated to this app's axes (x east, z south). Real terrain has hills,
 * so the ground height under the car is measured by ray casting every few
 * frames and the whole tileset is shifted to keep the road at y = 0.
 */
export class GoogleTilesLayer {
  readonly group = new THREE.Group();
  private readonly tiles: TilesRenderer;
  private readonly draco = new DRACOLoader();
  private readonly ray = new THREE.Raycaster();
  private groundOffset = 0;
  private frame = 0;
  private hasGround = false;
  /** Credit strings Google requires next to the imagery. */
  attribution = 'Google';
  onError?: (msg: string) => void;

  constructor(apiKey: string, origin: LatLng, camera: THREE.Camera, renderer: THREE.WebGLRenderer) {
    this.group.name = 'google-3d-tiles';
    this.draco.setDecoderPath(DRACO_DECODERS);
    const tiles = new TilesRenderer();
    tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: apiKey, autoRefreshToken: true }));
    tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: this.draco }));
    tiles.registerPlugin(new TileCompressionPlugin());
    tiles.registerPlugin(new TilesFadePlugin());
    tiles.registerPlugin(
      new ReorientationPlugin({ lat: toRad(origin.lat), lon: toRad(origin.lng), height: 0 }),
    );
    // Street level needs finer detail than the plugin's aerial default.
    tiles.errorTarget = 8;
    tiles.setCamera(camera);
    tiles.setResolutionFromRenderer(camera, renderer);
    let failures = 0;
    tiles.addEventListener('load-error', () => {
      failures++;
      if (failures === 5) {
        this.onError?.(
          'Google 3D tiles failed to load (is the Map Tiles API enabled for this key?). Showing the OpenStreetMap city instead.',
        );
      }
    });
    // The reoriented frame has X west and Z north; this app uses X east, Z south.
    const axes = new THREE.Group();
    axes.rotation.y = Math.PI;
    axes.add(tiles.group);
    this.group.add(axes);
    this.tiles = tiles;
  }

  /** Streams tiles for the current camera; call once per frame before rendering. */
  update(camera: THREE.Camera, renderer: THREE.WebGLRenderer, car: THREE.Vector3): void {
    this.tiles.setResolutionFromRenderer(camera, renderer);
    this.tiles.update();
    if (this.frame++ % 8 === 0) this.measureGround(car);
    this.group.position.y = -this.groundOffset;
    if (this.frame % 60 === 0) {
      const credits = this.tiles
        .getAttributions()
        .filter((a) => a.type === 'string')
        .map((a) => String(a.value));
      this.attribution = ['Google', ...credits].join(' · ');
    }
  }

  /** Ray-casts straight down at the car to find the terrain height there. */
  private measureGround(car: THREE.Vector3): void {
    this.ray.set(new THREE.Vector3(car.x, car.y + 400, car.z), new THREE.Vector3(0, -1, 0));
    this.group.updateMatrixWorld(true);
    const hits = this.ray.intersectObject(this.tiles.group, true);
    if (!hits.length) return;
    // Heights are measured in the shifted frame; add back the current offset.
    const ground = hits[0].point.y + this.groundOffset;
    // Smooth changes so driving over kerbs or tree canopies doesn't jolt the view.
    this.groundOffset = this.hasGround
      ? this.groundOffset + (ground - this.groundOffset) * 0.35
      : ground;
    this.hasGround = true;
  }

  dispose(): void {
    this.tiles.dispose();
    this.draco.dispose();
  }
}
