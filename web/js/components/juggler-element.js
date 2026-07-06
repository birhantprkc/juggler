//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Base class for Juggler custom elements with auto-cleanup of DOM listeners,
 * Yjs observers, timers, and arbitrary disposers.
 *
 * Subclasses register resources with the helpers below; disconnectedCallback
 * drains them in reverse order. Subclasses that override disconnectedCallback
 * MUST call `super.disconnectedCallback()` (or use `addCleanup`).
 *
 * Pattern mirrors {@link module:model/conversation-observers~setupYjsObservers}.
 */
class JugglerElement extends HTMLElement {
  constructor() {
    super();
    /** @type {Array<() => void>} @private */
    this._cleanups = [];
  }

  /**
   * Register a DOM event listener that will be removed on disconnect.
   * @param {EventTarget} target
   * @param {string} type
   * @param {EventListenerOrEventListenerObject} handler
   * @param {boolean|AddEventListenerOptions} [options]
   * @returns {() => void} Disposer that removes the listener immediately.
   */
  on(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    const dispose = () => target.removeEventListener(type, handler, options);
    this._cleanups.push(dispose);
    return dispose;
  }

  /**
   * Register a window-level DOM event listener with auto-removal.
   * @param {string} type
   * @param {EventListenerOrEventListenerObject} handler
   * @param {boolean|AddEventListenerOptions} [options]
   * @returns {() => void} Disposer that removes the listener immediately.
   */
  onWindow(type, handler, options) {
    return this.on(window, type, handler, options);
  }

  /**
   * Register a document-level DOM event listener with auto-removal.
   * @param {string} type
   * @param {EventListenerOrEventListenerObject} handler
   * @param {boolean|AddEventListenerOptions} [options]
   * @returns {() => void} Disposer that removes the listener immediately.
   */
  onDocument(type, handler, options) {
    return this.on(document, type, handler, options);
  }

  /**
   * Register a Yjs `.observe` with auto-detach on disconnect.
   * @param {{ observe: (h: any) => void, unobserve: (h: any) => void }} yType
   * @param {(...args: any[]) => void} handler
   * @returns {() => void} Disposer that unobserves immediately.
   */
  observe(yType, handler) {
    yType.observe(handler);
    const dispose = () => yType.unobserve(handler);
    this._cleanups.push(dispose);
    return dispose;
  }

  /**
   * Register a Yjs `.observeDeep` with auto-detach on disconnect.
   * @param {{ observeDeep: (h: any) => void, unobserveDeep: (h: any) => void }} yType
   * @param {(...args: any[]) => void} handler
   * @returns {() => void} Disposer that unobserves immediately.
   */
  observeDeep(yType, handler) {
    yType.observeDeep(handler);
    const dispose = () => yType.unobserveDeep(handler);
    this._cleanups.push(dispose);
    return dispose;
  }

  /**
   * Schedule a timeout with auto-clear on disconnect.
   * @param {() => void} fn
   * @param {number} ms
   * @returns {number} The timer id.
   */
  setTimeout(fn, ms) {
    const id = window.setTimeout(fn, ms);
    this._cleanups.push(() => window.clearTimeout(id));
    return id;
  }

  /**
   * Schedule an interval with auto-clear on disconnect.
   * @param {() => void} fn
   * @param {number} ms
   * @returns {number} The interval id.
   */
  setInterval(fn, ms) {
    const id = window.setInterval(fn, ms);
    this._cleanups.push(() => window.clearInterval(id));
    return id;
  }

  /**
   * Register an arbitrary disposer. Use for irregular resources
   * (ResizeObserver, IntersectionObserver, wsService.on, popup positioners).
   * @param {() => void} fn
   */
  addCleanup(fn) {
    this._cleanups.push(fn);
  }

  /**
   * Drain registered cleanups in reverse order. Subclass overrides must
   * call super.disconnectedCallback() (or invoke `this._runCleanups()`).
   */
  disconnectedCallback() {
    this._runCleanups();
  }

  /** @protected */
  _runCleanups() {
    while (this._cleanups.length) {
      const fn = this._cleanups.pop();
      try {
        fn?.();
      } catch (err) {
        console.error('[JugglerElement] cleanup error:', err);
      }
    }
  }
}

export default JugglerElement;
