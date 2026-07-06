//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * <no-project-overlay> — full-area placeholder shown when no project is
 * loaded. Keeps the empty window calm and points users at the header project
 * button instead of forcing a picker popup.
 */

class NoProjectOverlay extends HTMLElement {
  constructor() {
    super();
    /** @type {import('../model/session.js').default|null} @private */
    this._session = null;
    /** @type {Function|null} @private */
    this._unsubscribe = null;
    /** @type {boolean} @private */
    this._rendered = false;
  }

  disconnectedCallback() {
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
  }

  /**
   * @param {import('../model/session.js').default} session
   */
  setSession(session) {
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
    this._session = session;
    this._refresh();
    if (session) {
      this._unsubscribe = session.subscribe(/** @param {{type: string}} event */ (event) => {
        if (
          event.type === 'project:changed'
          || event.type === 'session:loaded'
          || event.type === 'conversation:created'
          || event.type === 'conversation:deleted'
        ) {
          this._refresh();
        }
      });
    }
  }

  /** @private */
  _refresh() {
    const empty = !this._session || !this._session.projectPath;

    const tabsContainer = /** @type {HTMLElement|null} */ (document.querySelector('conversation-tabs-container'));
    const convBar = /** @type {HTMLElement|null} */ (document.querySelector('conversation-bar'));

    if (!empty) {
      this.hidden = true;
      this._rendered = false;
      this.innerHTML = '';
      if (tabsContainer) tabsContainer.style.display = '';
      if (convBar) convBar.style.display = '';
      return;
    }

    this.hidden = false;
    if (tabsContainer) tabsContainer.style.display = 'none';
    if (convBar) convBar.style.display = 'none';

    if (!this._rendered) {
      this._rendered = true;
      this._render();
    }
  }

  /** @private */
  _render() {
    this.innerHTML = `
      <section class="no-project-onboarding" aria-label="Welcome to Juggler">
        <div class="no-project-logo" role="img" aria-label="Juggler"></div>
        <h1>Welcome to Juggler</h1>
        <p>
          Juggler is an AI coding agent designed around transparency, control, and fast iteration.
        </p>
        <p>
          Click <button type="button" class="no-project-inline-link no-project-project-link">'Set project folder'</button>
          above to open the codebase you want to work on.
        </p>
        <p class="no-project-settings-note">
          If you need to add provider keys, enter them in
          <button type="button" class="no-project-inline-link no-project-settings-link">settings</button>.
        </p>
        <p class="no-project-settings-note">
          New here? Browse the
          <button type="button" class="no-project-inline-link no-project-shortcuts-link">tips &amp; keyboard shortcuts</button>.
        </p>
      </section>
    `;

    const projectLink = this.querySelector('.no-project-project-link');
    if (projectLink) {
      projectLink.addEventListener('click', async () => {
        const { openProjectPicker } = await import('./project-picker.js');
        openProjectPicker(this._session?.projectPath || '', this._session);
      });
    }

    const settingsLink = this.querySelector('.no-project-settings-link');
    if (settingsLink) {
      settingsLink.addEventListener('click', () => {
        if ('openSettings' in window && typeof window.openSettings === 'function') {
          /** @type {any} */ (window).openSettings('providers');
        }
      });
    }

    const shortcutsLink = this.querySelector('.no-project-shortcuts-link');
    if (shortcutsLink) {
      shortcutsLink.addEventListener('click', () => {
        if ('openSettings' in window && typeof window.openSettings === 'function') {
          /** @type {any} */ (window).openSettings('shortcuts');
        }
      });
    }
  }
}

customElements.define('no-project-overlay', NoProjectOverlay);
export default NoProjectOverlay;
