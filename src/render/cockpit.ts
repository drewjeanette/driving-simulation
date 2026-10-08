import * as THREE from 'three';
import { Gear, GEAR_ORDER } from '../sim/transmission';

export interface ClusterData {
  speed: number; // display units
  units: 'mph' | 'km/h';
  rpm: number;
  gear: Gear;
  autoGear: number;
  limit: number | null; // display units
  signal: 'left' | 'right' | 'hazard' | null;
  blinkOn: boolean;
  throttle: number;
  brake: number;
}

export interface NavPanelData {
  glyph: string;
  instruction: string;
  distance: string;
  message: string;
}

/** Materials in the cockpit draw after the Street View sphere, so they sit in front of it. */
function cockpitMaterial(params: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ ...params, transparent: true, opacity: 1 });
}

/**
 * A simple car interior built from primitives: dashboard, hood, pillars,
 * mirror and a steering wheel that turns with the driver's input. The
 * instrument cluster is a live canvas texture, so it is readable in VR too.
 */
export class Cockpit {
  readonly group = new THREE.Group();
  readonly wheel = new THREE.Group();
  private readonly clusterCanvas = document.createElement('canvas');
  private readonly clusterTex: THREE.CanvasTexture;
  private readonly navCanvas = document.createElement('canvas');
  private readonly navTex: THREE.CanvasTexture;
  readonly navPanel: THREE.Mesh;
  private lastCluster = '';
  private lastNav = '';

  /** `driverSide` is -1 for a left-hand-drive car (US), +1 for right-hand drive (UK). */
  constructor(driverSide: -1 | 1) {
    this.group.name = 'cockpit';
    const seatX = 0.37 * -driverSide; // cabin centre relative to the driver's eye
    const dashMat = cockpitMaterial({ color: '#1b1d22', roughness: 0.85 });
    const trimMat = cockpitMaterial({ color: '#2a2d34', roughness: 0.6 });
    const paint = cockpitMaterial({ color: '#2f6fd6', roughness: 0.35, metalness: 0.4 });

    const dash = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.22, 0.6), dashMat);
    dash.position.set(seatX, -0.47, -0.85);
    dash.rotation.x = -0.12;
    this.group.add(dash);

    const hood = new THREE.Mesh(new THREE.BoxGeometry(1.75, 0.05, 1.6), paint);
    hood.position.set(seatX, -0.62, -2.1);
    hood.rotation.x = 0.05;
    this.group.add(hood);

    for (const side of [-1, 1]) {
      const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.0, 0.07), trimMat);
      pillar.position.set(seatX + side * 0.86, 0.0, -0.78);
      pillar.rotation.x = -0.65;
      pillar.rotation.z = side * 0.06;
      this.group.add(pillar);
    }
    const roof = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.06, 0.25), trimMat);
    roof.position.set(seatX, 0.46, -0.45);
    this.group.add(roof);

    const mirror = new THREE.Mesh(
      new THREE.BoxGeometry(0.22, 0.06, 0.02),
      cockpitMaterial({ color: '#0e1013', roughness: 0.2, metalness: 0.8 }),
    );
    mirror.position.set(seatX, 0.34, -0.62);
    this.group.add(mirror);

    // Steering wheel: rim, hub and three spokes.
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.022, 10, 40), dashMat);
    const hub = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.05, 0.04, 20).rotateX(Math.PI / 2),
      trimMat,
    );
    this.wheel.add(rim, hub);
    for (const a of [-Math.PI / 2, Math.PI + 0.15, -0.15]) {
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.028, 0.02), trimMat);
      spoke.position.set(Math.cos(a) * 0.095, Math.sin(a) * 0.095, 0);
      spoke.rotation.z = a;
      this.wheel.add(spoke);
    }
    const column = new THREE.Group();
    column.position.set(0, -0.4, -0.52);
    column.rotation.x = -0.35;
    column.add(this.wheel);
    this.group.add(column);

    // Instrument cluster behind the wheel.
    this.clusterCanvas.width = 512;
    this.clusterCanvas.height = 192;
    this.clusterTex = new THREE.CanvasTexture(this.clusterCanvas);
    this.clusterTex.colorSpace = THREE.SRGBColorSpace;
    const cluster = new THREE.Mesh(
      new THREE.PlaneGeometry(0.36, 0.135),
      new THREE.MeshBasicMaterial({ map: this.clusterTex, transparent: true, toneMapped: false }),
    );
    cluster.position.set(0, -0.33, -0.68);
    cluster.rotation.x = -0.3;
    this.group.add(cluster);

    // Floating navigation panel, shown in VR where the DOM HUD can't be seen.
    this.navCanvas.width = 768;
    this.navCanvas.height = 192;
    this.navTex = new THREE.CanvasTexture(this.navCanvas);
    this.navTex.colorSpace = THREE.SRGBColorSpace;
    this.navPanel = new THREE.Mesh(
      new THREE.PlaneGeometry(0.6, 0.15),
      new THREE.MeshBasicMaterial({
        map: this.navTex,
        transparent: true,
        toneMapped: false,
        depthTest: false,
      }),
    );
    this.navPanel.position.set(seatX * 0.5, -0.05, -0.95);
    this.navPanel.rotation.x = -0.1;
    this.navPanel.visible = false;
    this.group.add(this.navPanel);

    this.group.traverse((o) => (o.renderOrder = 10));
    this.navPanel.renderOrder = 11;
  }

  /** Wheel rotation follows road-wheel angle times a typical 15:1 steering ratio. */
  setSteer(roadWheelAngle: number): void {
    this.wheel.rotation.z = -roadWheelAngle * 15;
  }

  drawCluster(d: ClusterData): void {
    const key = `${Math.round(d.speed)}|${Math.round(d.rpm / 100)}|${d.gear}|${d.autoGear}|${d.limit}|${d.signal}|${d.blinkOn}`;
    if (key === this.lastCluster) return;
    this.lastCluster = key;
    const c = this.clusterCanvas;
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, c.width, c.height);
    roundRect(g, 4, 4, c.width - 8, c.height - 8, 28);
    g.fillStyle = 'rgba(8,10,14,0.92)';
    g.fill();

    // Tachometer arc
    const cx = 110;
    const cy = 112;
    g.lineWidth = 12;
    g.lineCap = 'round';
    g.strokeStyle = '#2b2f38';
    g.beginPath();
    g.arc(cx, cy, 66, Math.PI * 0.8, Math.PI * 2.2);
    g.stroke();
    const frac = Math.min(d.rpm / 7000, 1);
    g.strokeStyle = d.rpm > 5800 ? '#ef4444' : '#38bdf8';
    g.beginPath();
    g.arc(cx, cy, 66, Math.PI * 0.8, Math.PI * (0.8 + 1.4 * frac));
    g.stroke();
    g.fillStyle = '#9aa4b2';
    g.font = '600 18px system-ui, sans-serif';
    g.textAlign = 'center';
    g.fillText(`${(d.rpm / 1000).toFixed(1)}`, cx, cy + 6);
    g.font = '500 13px system-ui, sans-serif';
    g.fillText('x1000 rpm', cx, cy + 26);

    // Speed
    g.fillStyle = '#f8fafc';
    g.font = '700 84px system-ui, sans-serif';
    g.fillText(`${Math.round(Math.abs(d.speed))}`, 268, 118);
    g.fillStyle = '#9aa4b2';
    g.font = '600 18px system-ui, sans-serif';
    g.fillText(d.units, 268, 148);

    // Gear strip
    GEAR_ORDER.forEach((gear, i) => {
      const x = 384 + i * 30;
      const active = gear === d.gear;
      g.fillStyle = active ? '#f8fafc' : '#4b5563';
      g.font = `${active ? 800 : 600} ${active ? 30 : 22}px system-ui, sans-serif`;
      g.fillText(gear, x, 70);
    });
    if (d.gear === 'D') {
      g.fillStyle = '#9aa4b2';
      g.font = '600 15px system-ui, sans-serif';
      g.fillText(`gear ${d.autoGear}`, 429, 96);
    }

    // Speed limit sign
    if (d.limit !== null) {
      g.fillStyle = '#ffffff';
      roundRect(g, 404, 112, 52, 62, 8);
      g.fill();
      g.fillStyle = '#111';
      g.font = '700 11px system-ui, sans-serif';
      g.fillText('LIMIT', 430, 128);
      g.font = '800 26px system-ui, sans-serif';
      g.fillText(`${Math.round(d.limit)}`, 430, 160);
    }

    // Turn signals
    const lit = (side: 'left' | 'right') =>
      d.blinkOn && (d.signal === side || d.signal === 'hazard');
    arrow(g, 30, 28, -1, lit('left'));
    arrow(g, 482, 28, 1, lit('right'));
    this.clusterTex.needsUpdate = true;
  }

  drawNav(d: NavPanelData): void {
    const key = `${d.glyph}|${d.instruction}|${d.distance}|${d.message}`;
    if (key === this.lastNav) return;
    this.lastNav = key;
    const c = this.navCanvas;
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, c.width, c.height);
    roundRect(g, 4, 4, c.width - 8, c.height - 8, 30);
    g.fillStyle = 'rgba(12,18,32,0.88)';
    g.fill();
    g.fillStyle = '#60a5fa';
    g.font = '700 84px system-ui, sans-serif';
    g.textAlign = 'center';
    g.fillText(d.glyph, 80, 118);
    g.textAlign = 'left';
    g.fillStyle = '#f8fafc';
    g.font = '700 40px system-ui, sans-serif';
    g.fillText(d.distance, 150, 70);
    g.font = '500 28px system-ui, sans-serif';
    g.fillStyle = '#cbd5e1';
    g.fillText(truncate(g, d.instruction, 590), 150, 112);
    if (d.message) {
      g.fillStyle = '#fbbf24';
      g.font = '600 26px system-ui, sans-serif';
      g.fillText(truncate(g, d.message, 590), 150, 156);
    }
    this.navTex.needsUpdate = true;
  }

  dispose(): void {
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
    this.clusterTex.dispose();
    this.navTex.dispose();
  }
}

function roundRect(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}

function arrow(g: CanvasRenderingContext2D, x: number, y: number, dir: -1 | 1, lit: boolean) {
  g.fillStyle = lit ? '#22c55e' : '#1f2937';
  g.beginPath();
  g.moveTo(x + dir * 18, y);
  g.lineTo(x - dir * 2, y - 14);
  g.lineTo(x - dir * 2, y + 14);
  g.closePath();
  g.fill();
}

function truncate(g: CanvasRenderingContext2D, text: string, max: number): string {
  if (g.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && g.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t}…`;
}
