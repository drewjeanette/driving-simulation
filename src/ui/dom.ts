type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | number | boolean | EventListener | undefined>;

/**
 * Tiny element builder. Text always goes through text nodes, never HTML, so
 * place names and route instructions from third-party APIs can't inject markup.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === 'class') {
      node.className = String(v);
    } else if (v === true) {
      node.setAttribute(k, '');
    } else {
      node.setAttribute(k, String(v));
    }
  }
  append(node, ...children);
  return node;
}

export function append(parent: Node, ...children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    parent.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Icons are static, hard-coded path data (Lucide-style, 24x24, stroked). */
const ICONS: Record<string, string[]> = {
  search: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z', 'M21 21l-4.3-4.3'],
  swap: ['M7 16V4m0 0L3 8m4-4 4 4', 'M17 8v12m0 0 4-4m-4 4-4-4'],
  locate: [
    'M12 2v3M12 19v3M2 12h3M19 12h3',
    'M12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12z',
    'M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  ],
  play: ['M6 4l14 8-14 8z'],
  pause: ['M7 4h3v16H7zM14 4h3v16h-3z'],
  settings: [
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  ],
  vr: [
    'M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-4l-2-3h-2l-2 3H5a2 2 0 0 1-2-2z',
    'M8 12.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM16 12.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
  ],
  camera: [
    'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z',
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  ],
  volume: ['M11 5 6 9H2v6h4l5 4z', 'M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14'],
  mute: ['M11 5 6 9H2v6h4l5 4z', 'M22 9l-6 6M16 9l6 6'],
  close: ['M18 6 6 18M6 6l12 12'],
  globe: [
    'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z',
    'M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20',
  ],
  back: ['M19 12H5m7-7-7 7 7 7'],
  gamepad: [
    'M6 11h4M8 9v4M15 12h.01M18 10h.01',
    'M17.3 5H6.7a4 4 0 0 0-4 3.6l-.7 6.3A3 3 0 0 0 5 18c1 0 2-.5 2.6-1.4L9 15h6l1.4 1.6A3 3 0 0 0 19 18a3 3 0 0 0 3-3.1l-.7-6.3A4 4 0 0 0 17.3 5z',
  ],
  wheel: [
    'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z',
    'M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
    'M4 10h6M14 10h6M12 14v8',
  ],
  keyboard: ['M3 6h18v12H3z', 'M7 10h.01M11 10h.01M15 10h.01M7 14h10'],
  github: [
    'M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21',
  ],
  flag: ['M4 22V4m0 0s1-1 4-1 5 2 8 2 4-1 4-1v11s-1 1-4 1-5-2-8-2-4 1-4 1'],
  restart: ['M3 12a9 9 0 1 0 3-6.7L3 8', 'M3 3v5h5'],
  route: [
    'M6 19a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    'M9 16h6a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h3',
  ],
  info: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M12 16v-4M12 8h.01'],
};

export function icon(name: keyof typeof ICONS | string, size = 18): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ICONS[name] ?? []) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

let toastHost: HTMLElement | null = null;

export function toast(message: string, kind: 'info' | 'warn' | 'error' = 'info', ms = 4200): void {
  toastHost ??= document.body.appendChild(
    el('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }),
  );
  const t = el('div', { class: `toast toast-${kind}` }, message);
  toastHost.append(t);
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 300);
  }, ms);
}

export function debounce<A extends unknown[]>(
  fn: (...a: A) => void,
  ms: number,
): (...a: A) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...a: A) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...a), ms);
  };
}
