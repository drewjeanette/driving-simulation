import { LatLng } from '../geo/geo';
import { Place, SearchProvider } from '../providers/types';
import { Globe } from './globe';
import { SearchBox } from './searchbox';
import { el, icon } from './dom';

export const REPO_URL = 'https://github.com/drewjeanette/driving-simulation';

/** Landing page: pitch, address search and the pick-a-spot globe. */
export class LandingScreen {
  readonly root: HTMLElement;
  private globe: Globe | null = null;
  private readonly globeHost = el('div', { class: 'globe-host' });
  onChoose?: (p: LatLng, label?: string) => void;
  onPlan?: () => void;

  constructor(search: SearchProvider, mode: 'google' | 'open') {
    const box = new SearchBox(search, {
      label: 'Where do you want to practise?',
      placeholder: 'Type an address or city',
      badge: 'A',
    });
    box.onSelect = (p: Place) => this.onChoose?.(p.location, p.label);

    const features: [string, string, string][] = [
      [
        'route',
        'Real routes',
        'Search an address or tap the globe, then drive the actual streets.',
      ],
      [
        'camera',
        '360° street photos',
        'Real street-level imagery with smooth, continuous motion, not slideshow jumps.',
      ],
      [
        'wheel',
        'Wheel, pad or keys',
        'Racing wheels and pedals, Xbox and PlayStation controllers, or a keyboard.',
      ],
      ['vr', 'VR ready', 'Put on a headset and look around the cabin with your head.'],
    ];

    this.root = el(
      'section',
      { class: 'screen landing' },
      el(
        'header',
        { class: 'topbar' },
        el(
          'a',
          { class: 'brand', href: './' },
          el('span', { class: 'brand-mark' }, 'DS'),
          'Drive Sim',
        ),
        el(
          'nav',
          {},
          el(
            'a',
            { href: REPO_URL, target: '_blank', rel: 'noopener noreferrer', class: 'link-btn' },
            icon('github', 16),
            'Source',
          ),
        ),
      ),
      el(
        'div',
        { class: 'hero' },
        el(
          'div',
          { class: 'hero-copy' },
          el(
            'p',
            { class: 'eyebrow' },
            el('span', { class: 'dot' }),
            'Practice for your road test',
          ),
          el(
            'h1',
            {},
            'Learn to drive on ',
            el('span', { class: 'accent' }, 'real streets'),
            ', from anywhere.',
          ),
          el(
            'p',
            { class: 'lede' },
            'Pick any route in the world and drive it with real gas, brake, steering and a P R N D gear selector. A built-in examiner scores your signals, speed, lane position and smoothness.',
          ),
          el(
            'div',
            { class: 'hero-search glass' },
            box.root,
            el(
              'button',
              { class: 'btn btn-primary', onclick: () => this.onPlan?.() },
              'Plan a route',
            ),
          ),
          el(
            'p',
            { class: 'globe-tip' },
            icon('globe', 15),
            'Or spin the globe and click anywhere to start there.',
          ),
          el(
            'ul',
            { class: 'features' },
            ...features.map(([i, t, d]) =>
              el(
                'li',
                {},
                el('span', { class: 'feat-icon' }, icon(i, 18)),
                el('div', {}, el('strong', {}, t), el('span', {}, d)),
              ),
            ),
          ),
        ),
        this.globeHost,
      ),
      el(
        'footer',
        { class: 'landing-foot' },
        el(
          'span',
          {},
          mode === 'google'
            ? 'Maps & imagery © Google'
            : 'Map data © OpenStreetMap contributors · Imagery © Mapillary contributors',
        ),
        el(
          'span',
          {},
          'A practice aid, not a substitute for real lessons with a licensed instructor.',
        ),
      ),
    );
  }

  mount(): void {
    try {
      this.globe = new Globe(this.globeHost);
      this.globe.onPick = (p) => {
        setTimeout(() => this.onChoose?.(p), 650); // let the pin animation play
      };
    } catch {
      this.globeHost.append(
        el('p', { class: 'hint' }, 'The 3D globe needs WebGL, which is unavailable here.'),
      );
    }
  }

  destroy(): void {
    this.globe?.dispose();
    this.root.remove();
  }
}
