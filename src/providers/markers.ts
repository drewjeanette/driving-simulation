/** DOM markers shared by both map providers. */
export function markerElement(label: 'A' | 'B'): HTMLElement {
  const el = document.createElement('div');
  el.className = `pin pin-${label === 'A' ? 'start' : 'end'}`;
  const span = document.createElement('span');
  span.textContent = label;
  el.append(span);
  return el;
}

export function carElement(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'car-marker';
  el.setAttribute('aria-label', 'Your car');
  return el;
}

/**
 * Padding that keeps a fitted route clear of the planner panel: the panel
 * sits on the left on wide screens and along the bottom on phones.
 */
export function routePadding(): { top: number; right: number; bottom: number; left: number } {
  const wide = window.innerWidth > 900;
  return wide
    ? { top: 60, right: 60, bottom: 60, left: 460 }
    : { top: 60, right: 30, bottom: Math.round(window.innerHeight * 0.6), left: 30 };
}
