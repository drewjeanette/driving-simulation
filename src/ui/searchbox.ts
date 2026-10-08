import { LatLng } from '../geo/geo';
import { Place, PlaceSuggestion, SearchProvider } from '../providers/types';
import { debounce, el, icon, clear } from './dom';

let uid = 0;

/** Accessible address autocomplete (ARIA combobox pattern). */
export class SearchBox {
  readonly root: HTMLElement;
  readonly input: HTMLInputElement;
  private readonly list: HTMLUListElement;
  private items: PlaceSuggestion[] = [];
  private active = -1;
  private seq = 0;
  onSelect?: (place: Place) => void;
  near?: () => LatLng | undefined;

  constructor(
    private readonly provider: SearchProvider,
    opts: { label: string; placeholder: string; badge: string },
  ) {
    const id = `search-${uid++}`;
    this.input = el('input', {
      id,
      class: 'search-input',
      type: 'text',
      placeholder: opts.placeholder,
      autocomplete: 'off',
      spellcheck: 'false',
      role: 'combobox',
      'aria-autocomplete': 'list',
      'aria-expanded': 'false',
      'aria-controls': `${id}-list`,
      maxlength: 200,
    });
    this.list = el('ul', { id: `${id}-list`, class: 'search-list', role: 'listbox', hidden: true });
    this.root = el(
      'div',
      { class: 'search' },
      el('label', { class: 'sr-only', for: id }, opts.label),
      el(
        'span',
        { class: `search-badge badge-${opts.badge.toLowerCase()}`, 'aria-hidden': 'true' },
        opts.badge,
      ),
      this.input,
      el('span', { class: 'search-icon' }, icon('search', 16)),
      this.list,
    );

    const run = debounce((q: string) => void this.fetch(q), 260);
    this.input.addEventListener('input', () => run(this.input.value));
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    this.input.addEventListener('blur', () => setTimeout(() => this.close(), 150));
    this.input.addEventListener('focus', () => this.input.select());
  }

  setValue(text: string): void {
    this.input.value = text;
    this.close();
  }

  private async fetch(q: string): Promise<void> {
    const seq = ++this.seq;
    if (q.trim().length < 3) {
      this.close();
      return;
    }
    try {
      const items = await this.provider.suggest(q, this.near?.());
      if (seq !== this.seq) return; // a newer query superseded this one
      this.items = items;
      this.render();
    } catch (err) {
      if (seq !== this.seq) return;
      this.items = [];
      this.renderMessage(`Search failed: ${(err as Error).message}`);
    }
  }

  private render(): void {
    clear(this.list);
    this.active = -1;
    if (!this.items.length) {
      this.renderMessage('No matches. Try a fuller address.');
      return;
    }
    this.items.forEach((s, i) => {
      const li = el(
        'li',
        { id: `${this.input.id}-opt-${i}`, role: 'option', class: 'search-option' },
        el('span', { class: 'opt-primary' }, s.primary),
        s.secondary ? el('span', { class: 'opt-secondary' }, s.secondary) : null,
      );
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        void this.choose(i);
      });
      this.list.append(li);
    });
    this.open();
  }

  private renderMessage(text: string): void {
    clear(this.list);
    this.list.append(el('li', { class: 'search-empty' }, text));
    this.open();
  }

  private open(): void {
    this.list.hidden = false;
    this.input.setAttribute('aria-expanded', 'true');
  }

  private close(): void {
    this.list.hidden = true;
    this.input.setAttribute('aria-expanded', 'false');
    this.input.removeAttribute('aria-activedescendant');
  }

  private onKey(e: KeyboardEvent): void {
    if (this.list.hidden || !this.items.length) {
      if (e.key === 'Enter') void this.fetch(this.input.value);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = this.items.length;
      this.active = (this.active + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
      [...this.list.children].forEach((c, i) => c.classList.toggle('active', i === this.active));
      this.input.setAttribute('aria-activedescendant', `${this.input.id}-opt-${this.active}`);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      void this.choose(Math.max(0, this.active));
    } else if (e.key === 'Escape') {
      this.close();
    }
  }

  private async choose(i: number): Promise<void> {
    const s = this.items[i];
    if (!s) return;
    this.close();
    this.input.value = s.primary;
    try {
      const place = await s.resolve();
      this.input.value = place.label;
      this.onSelect?.(place);
    } catch (err) {
      this.renderMessage(`Couldn't load that place: ${(err as Error).message}`);
    }
  }
}
