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
