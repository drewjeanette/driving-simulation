import { el, icon } from './dom';

/** Accessible dialog built on <dialog>, with focus restore and Esc to close. */
export class Modal {
  readonly dialog: HTMLDialogElement;
  readonly body: HTMLElement;
  private readonly previous = document.activeElement as HTMLElement | null;
  onClose?: () => void;

  constructor(title: string, opts: { wide?: boolean; dismissable?: boolean } = {}) {
    this.body = el('div', { class: 'modal-body' });
    const header = el(
      'header',
      { class: 'modal-head' },
      el('h2', {}, title),
      opts.dismissable === false
        ? null
        : el(
            'button',
            { class: 'icon-btn', 'aria-label': 'Close', onclick: () => this.close() },
            icon('close', 16),
          ),
    );
    this.dialog = el(
      'dialog',
      { class: `modal${opts.wide ? ' modal-wide' : ''}` },
      header,
      this.body,
    );
    this.dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      if (opts.dismissable !== false) this.close();
    });
    this.dialog.addEventListener('click', (e) => {
      if (e.target === this.dialog && opts.dismissable !== false) this.close();
    });
    document.body.append(this.dialog);
    this.dialog.showModal();
  }

  close(): void {
    if (!this.dialog.isConnected) return;
    this.dialog.close();
    this.dialog.remove();
    this.previous?.focus?.();
    this.onClose?.();
  }
}
