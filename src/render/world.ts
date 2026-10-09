import * as THREE from 'three';
import { DrivePath } from '../geo/path';
import { Vec2 } from '../geo/geo';

/**
 * Flat layers (ground, road, sidewalks) never hide anything that matters, so
 * they skip the depth buffer and are painted back to front in a fixed order.
 * That makes them immune to z-fighting and to the depth artefacts very large
 * ground triangles cause on some GPUs and software rasterisers.
 */
function flatLayer<T extends THREE.Mesh>(mesh: T, order: number): T {
  (mesh.material as THREE.Material).depthWrite = false;
  mesh.renderOrder = order;
  return mesh;
}

/** Local (east, north) metres to three.js world space (x east, y up, -z north). */
export function toThree(p: Vec2, y = 0): THREE.Vector3 {
  return new THREE.Vector3(p.x, y, -p.y);
}

/** Small deterministic PRNG so scenery is identical every drive of a route. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ROAD_HALF = 4.2; // asphalt half-width, m
const CURB_HALF = 6.2; // to the outer edge of the sidewalk, m

function roadTexture(rightHand: boolean): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 512;
  const g = c.getContext('2d')!;
  // Asphalt with a little grain.
  g.fillStyle = '#3b3e44';
  g.fillRect(0, 0, c.width, c.height);
  const rnd = mulberry32(7);
  for (let i = 0; i < 5000; i++) {
    const v = 50 + rnd() * 30;
    g.fillStyle = `rgba(${v},${v},${v + 4},0.35)`;
    g.fillRect(rnd() * c.width, rnd() * c.height, 1.5, 1.5);
  }
  const px = (m: number) => ((m + ROAD_HALF) / (2 * ROAD_HALF)) * c.width;
  // Solid white edge lines.
  g.fillStyle = '#e8e8e8';
  g.fillRect(px(-ROAD_HALF + 0.3), 0, 4, c.height);
  g.fillRect(px(ROAD_HALF - 0.3) - 4, 0, 4, c.height);
  // Centre line: double yellow in right-hand countries, dashed white elsewhere.
  if (rightHand) {
    g.fillStyle = '#f2c230';
    g.fillRect(px(-0.12) - 2, 0, 3, c.height);
    g.fillRect(px(0.12) - 1, 0, 3, c.height);
  } else {
    g.fillStyle = '#e8e8e8';
    for (let y = 0; y < c.height; y += 128) g.fillRect(px(0) - 2, y, 4, 64);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** A ribbon mesh that follows the path at a lateral band [from, to] metres. */
function ribbon(
  points: { p: Vec2; h: number; s: number }[],
  from: number,
  to: number,
  y: number,
  vScale: number,
) {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  points.forEach(({ p, h, s }, i) => {
    const rx = Math.cos(h);
    const ry = -Math.sin(h);
    pos.push(p.x + rx * from, y, -(p.y + ry * from));
    pos.push(p.x + rx * to, y, -(p.y + ry * to));
    uv.push(0, s / vScale, 1, s / vScale);
    if (i > 0) {
      const a = (i - 1) * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Builds a stylised neighbourhood along the route: road with lane markings,
 * sidewalks, cross streets at every manoeuvre, houses, trees and street
 * lights. Used on its own in Open mode and underneath Street View imagery
 * wherever Google has no coverage.
 */
export function buildWorld(path: DrivePath, rightHand: boolean): THREE.Group {
  const world = new THREE.Group();
  world.name = 'procedural-world';
  const stride = 2;
  const samples: { p: Vec2; h: number; s: number }[] = [];
  for (let s = 0; s <= path.length; s += stride) {
    const smp = path.sample(s);
    samples.push({ p: { x: smp.x, y: smp.y }, h: smp.heading, s });
  }

  const ground = new THREE.Mesh(
    // Finely subdivided: a few giant triangles break fog and depth precision.
    new THREE.PlaneGeometry(3000, 3000, 60, 60).rotateX(-Math.PI / 2),
    new THREE.MeshLambertMaterial({ color: '#7fa65a' }),
  );
  ground.name = 'ground'; // re-centred under the car every frame
  ground.receiveShadow = true;
  ground.position.y = -0.05;
  world.add(flatLayer(ground, -9));

  const road = new THREE.Mesh(
    ribbon(samples, -ROAD_HALF, ROAD_HALF, 0.01, 12),
    new THREE.MeshLambertMaterial({ map: roadTexture(rightHand) }),
  );
  road.receiveShadow = true;
  world.add(flatLayer(road, -7));

  // Everything below is generic stand-in scenery, hidden once the real 3D
  // city from OpenStreetMap has loaded.
  const generic = new THREE.Group();
  generic.name = 'generic-scenery';
  world.add(generic);

  const walkMat = new THREE.MeshLambertMaterial({ color: '#b9b4aa' });
  generic.add(
    flatLayer(new THREE.Mesh(ribbon(samples, ROAD_HALF, CURB_HALF, 0.12, 4), walkMat), -6),
  );
  generic.add(
    flatLayer(new THREE.Mesh(ribbon(samples, -CURB_HALF, -ROAD_HALF, 0.12, 4), walkMat), -6),
  );

  // Cross streets where the route turns, so intersections read as intersections.
  const crossMat = new THREE.MeshLambertMaterial({ color: '#3b3e44' });
  for (const step of path.steps) {
    if (step.maneuver === 'depart' || step.maneuver === 'arrive') continue;
    const at = path.sample(step.s);
    const cross = new THREE.Mesh(
      new THREE.PlaneGeometry(2 * ROAD_HALF, 120).rotateX(-Math.PI / 2),
      crossMat,
    );
    cross.position.copy(toThree(at, 0.005));
    cross.rotation.y = -(at.heading + Math.PI / 2);
    generic.add(flatLayer(cross, -8));
  }

  scatter(generic, path, samples);
  return world;
}

function scatter(
  world: THREE.Group,
  path: DrivePath,
  samples: { p: Vec2; h: number; s: number }[],
) {
  const rnd = mulberry32(Math.round(path.length) + 11);
  const trunk = new THREE.CylinderGeometry(0.18, 0.25, 2.2, 6).translate(0, 1.1, 0);
  const crown = new THREE.IcosahedronGeometry(1.8, 0).translate(0, 3.6, 0);
  const house = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const roof = new THREE.ConeGeometry(0.75, 0.5, 4).rotateY(Math.PI / 4).translate(0, 1.25, 0);
  const pole = new THREE.CylinderGeometry(0.07, 0.09, 6, 6).translate(0, 3, 0);

  const count = Math.ceil(path.length / 9) * 2;
  const trunks = new THREE.InstancedMesh(
    trunk,
    new THREE.MeshLambertMaterial({ color: '#6b4f35' }),
    count,
  );
  const crowns = new THREE.InstancedMesh(
    crown,
    new THREE.MeshLambertMaterial({ color: '#4f8a3c', flatShading: true }),
    count,
  );
  const houses = new THREE.InstancedMesh(
    house,
    new THREE.MeshLambertMaterial({ color: '#ffffff' }),
    count,
  );
  const roofs = new THREE.InstancedMesh(
    roof,
    new THREE.MeshLambertMaterial({ color: '#8a4b3a', flatShading: true }),
    count,
  );
  const poles = new THREE.InstancedMesh(
    pole,
    new THREE.MeshLambertMaterial({ color: '#5d6168' }),
    count,
  );

  const palette = ['#e9dcc9', '#d7e3ea', '#f1e4b3', '#e5c9c0', '#cfd8c4', '#f4f1ea'];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const color = new THREE.Color();
  let t = 0;
  let h = 0;
  let l = 0;

  // Reject positions too close to any part of the road (tight bends would
  // otherwise put a house in the middle of the next street).
  let hint = 0;
  const clear = (x: number, y: number, min: number) => path.project({ x, y }, hint).distance > min;

  for (let i = 0; i < samples.length; i += 4) {
    const { p, h: heading, s } = samples[i];
    hint = s;
    for (const side of [-1, 1]) {
      const rx = Math.cos(heading) * side;
      const ry = -Math.sin(heading) * side;
      if (rnd() < 0.55 && t < count) {
        const off = CURB_HALF + 1.5 + rnd() * 4;
        const x = p.x + rx * off;
        const y = p.y + ry * off;
        if (clear(x, y, CURB_HALF + 1)) {
          const k = 0.7 + rnd() * 0.7;
          m.compose(
            new THREE.Vector3(x, 0, -y),
            q.setFromEuler(new THREE.Euler(0, rnd() * 6, 0)),
            scale.set(k, k, k),
          );
          trunks.setMatrixAt(t, m);
          crowns.setMatrixAt(t, m);
          t++;
        }
      }
      if (rnd() < 0.3 && h < count && i % 8 === 0) {
        const off = CURB_HALF + 12 + rnd() * 6;
        const x = p.x + rx * off;
        const y = p.y + ry * off;
        if (clear(x, y, CURB_HALF + 9)) {
          const w = 8 + rnd() * 5;
          const d = 8 + rnd() * 4;
          const ht = 3 + rnd() * 3.5;
          q.setFromEuler(new THREE.Euler(0, -heading, 0));
          m.compose(new THREE.Vector3(x, 0, -y), q, scale.set(w, ht, d));
          houses.setMatrixAt(h, m);
          houses.setColorAt(h, color.set(palette[Math.floor(rnd() * palette.length)]));
          m.compose(
            new THREE.Vector3(x, ht - 1, -y),
            q,
            scale.set(w * 1.05, ht * 0.6 + 1.5, d * 1.05),
          );
          roofs.setMatrixAt(h, m);
          h++;
        }
      }
      if (side === 1 && Math.round(s) % 40 < 8 && l < count) {
        const off = CURB_HALF - 0.4;
        m.compose(
          new THREE.Vector3(p.x + rx * off, 0, -(p.y + ry * off)),
          q.identity(),
          scale.set(1, 1, 1),
        );
        poles.setMatrixAt(l++, m);
      }
    }
  }
  for (const [mesh, n] of [
    [trunks, t],
    [crowns, t],
    [houses, h],
    [roofs, h],
    [poles, l],
  ] as const) {
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.frustumCulled = false;
    world.add(mesh);
  }
}

/** Gradient sky dome with a soft sun glow. */
export function buildSky(): THREE.Mesh {
  const geo = new THREE.SphereGeometry(3000, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: { sunDir: { value: new THREE.Vector3(0.4, 0.55, -0.7).normalize() } },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 sunDir;
      varying vec3 vDir;
      void main() {
        float h = clamp(vDir.y, -0.1, 1.0);
        vec3 horizon = vec3(0.86, 0.91, 0.96);
        vec3 zenith = vec3(0.29, 0.53, 0.86);
        vec3 col = mix(horizon, zenith, pow(max(h, 0.0), 0.55));
        float sun = max(dot(normalize(vDir), sunDir), 0.0);
        col += vec3(1.0, 0.9, 0.7) * (pow(sun, 400.0) * 1.5 + pow(sun, 8.0) * 0.15);
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const sky = new THREE.Mesh(geo, mat);
  sky.name = 'sky';
  sky.renderOrder = -10;
  sky.frustumCulled = false;
  return sky;
}
