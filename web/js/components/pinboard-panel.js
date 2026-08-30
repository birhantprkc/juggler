//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * <pinboard-panel> — the board itself, in three bands: a toolbar that names the
 * surface, a strip of tabs, and the active pin. It is the only piece that reads
 * both the shared board and this viewer's view of it, and it routes every edit
 * through the host service rather than the store, so dedupe, reveal and the
 * status line all happen in one place.
 *
 * The panel also resolves the active-context snapshot — the project, the visible
 * conversation, the thread being read — and hands it down. Item types never walk
 * session internals to find that out for themselves.
 *
 * A detached board resolves the same snapshot from the same session, with one
 * substitution: the conversation is the one named in its URL rather than the one
 * this viewer happens to be showing, and the thread is that conversation's root.
 * A board is a window onto one conversation and stays there — which is what makes
 * it worth leaving open on work that takes a while — so nothing it shows depends
 * on the window it was detached from still existing, or still being anywhere near
 * the conversation it was detached from.
 * @module components/pinboard-panel
 */

import JugglerElement from './juggler-element.js';
import pinboardStore from '../services/pinboard-store.js';
import pinboardView from '../services/pinboard-view.js';
import pinboardItemRegistry from '../registries/pinboard-item-registry.js';
import { REGISTRIES_RELOADED } from '../registries/reload-registries.js';
import { THREAD_FOCUS_CHANGED } from './conversation-tab.js';
import { extractErrorMessage } from '../../sdk/lib/error-utils.js';
import { openAddPicker } from './pinboard-add-picker.js';
import { describePin, revealInConversation } from './pinboard-content.js';
import { raiseThisWindow } from '../../sdk/lib/window-control.js';
import { ownerLink, satelliteLink, canLinkBoards, onLinkAvailability } from '../services/pinboard-link.js';
import { isPinboardView, boardConversationId } from '../utils/view-mode.js';
import './pinboard-tabbar.js';
import './pinboard-content.js';

/** @typedef {import('juggler/pinboard-item-type').PinActiveContext} PinActiveContext */

/** Material "open in new" icon, for the control that gives the board a window. */
const POPOUT_ICON_PATH = 'M200-120q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h240v80H200v560h560v-240h80v240q0 33-23.5 56.5T760-120H200Zm440-400v-120H520v-80h120v-120h80v120h120v80H720v120h-80Z';

/**
 * The last segment of a path, whichever separator the platform uses.
 * @param {string} path - A project path.
 * @returns {string} The name to show.
 */
function baseName(path) {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts.length ? /** @type {string} */ (parts[parts.length - 1]) : path;
}

/**
 * The thread the viewer is looking at in the visible conversation. A root column
 * has no thread item of its own, which is what null means here.
 * @returns {string|null} The focused thread item's id, or null for the root.
 */
function focusedThreadId() {
  const tab = /** @type {any} */ (document.querySelector('conversation-tab.active'));
  return tab?.getFocusedThreadItemId?.() ?? null;
}

/**
 * Wait until a conversation's column is the one on screen, so a reveal aimed at
 * it has something to aim at. Switching mounts the tab and marks it active, but
 * not in the same turn — and a reveal that arrives before that has no columns to
 * scroll.
 *
 * It resolves on the deadline rather than hanging: a tab that never arrives is a
 * reveal that lands nowhere, which is a better outcome than a promise nothing
 * settles. Timers rather than frames, because the window may still be behind
 * another when this runs, and a hidden window paints none.
 * @param {string} conversationId - The conversation whose column to wait for.
 * @param {number} [timeoutMs] - How long to wait before giving up.
 * @returns {Promise<void>} Resolves when the column is up, or on the deadline.
 */
function waitForTab(conversationId, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      const tab = document.getElementById(`conversation-tab-${conversationId}`);
      if (tab?.classList.contains('active') || Date.now() >= deadline) {
        resolve();
        return;
      }
      setTimeout(check, 16);
    };
    check();
  });
}

class PinboardPanel extends JugglerElement {
  constructor() {
    super();
    /** @type {import('../model/session.js').default|null} @private */
    this._session = null;
    /** @type {(() => void)|null} @private */
    this._unsubscribeSession = null;
    /** @type {any} @private */
    this._tabbar = null;
    /** @type {any} @private */
    this._content = null;
    /** @type {HTMLElement|null} @private */
    this._status = null;
    /** @type {(() => void)|null} @private The open add picker's close fn. */
    this._closePicker = null;
    /** @type {string} @private The last snapshot rendered, to spot a real change. */
    this._contextJson = '';
    /** @type {HTMLElement|null} @private Stands in for the board while there is none. */
    this._placeholder = null;
    /**
     * How far a detached board has got with the conversation named in its URL:
     * 'opening' until the session has been asked for it, then 'ready' or
     * 'missing'. A board that guessed instead of waiting would draw an empty
     * Plan, no changed files and no running tasks over a conversation that is
     * merely still loading — and would look right doing it.
     * @type {'opening'|'ready'|'missing'} @private
     */
    this._boardState = 'opening';
    /** @type {HTMLButtonElement|null} @private Shown once this viewer has an address. */
    this._popOutButton = null;
  }

  connectedCallback() {
    this._build();
    this.addCleanup(pinboardStore.subscribe(() => this._render()));
    this.addCleanup(pinboardView.subscribe(() => this._render()));
    // A hot-reloaded extension is a different class: everything mounted against
    // the old one has to come down before anything is mounted against the new.
    this.onDocument(REGISTRIES_RELOADED, () => this._remount());
    // Column selection is not session state, so this is the only notice the
    // board gets that the user has moved into or out of a sub-thread.
    this.onDocument(THREAD_FOCUS_CHANGED, () => this._render());
    // A board has no columns, so pointing at a thread is something it asks the
    // window it was detached from to do. That is all the link is for now, and it
    // is why a board with no owner left is a board that still works.
    if (isPinboardView()) satelliteLink.start();
    else this._restoreBoards();
    this._render();
  }

  /**
   * Reopen the boards that were open when Juggler was last shut.
   *
   * It happens here, in the page, because a board is opened by a viewer and
   * addressed to one. The viewer id is minted by the browser into sessionStorage
   * and does not outlive the process, so the owner recorded with a board last
   * run reaches nobody this run — and only a live window knows its own id.
   * Reopening from a window is therefore not a workaround: it is the only place
   * an owner exists at all.
   *
   * The id arrives on the session frame, always later than this element
   * upgrades, so this waits for it rather than sampling it once and getting the
   * empty answer every time. The server answers the claim once, so every main
   * window of a project can ask and only the first is given anything.
   * @private
   */
  _restoreBoards() {
    let asked = false;
    this.addCleanup(onLinkAvailability(() => {
      if (asked || !canLinkBoards()) return;
      asked = true;
      void ownerLink.restoreBoards();
    }));
  }

  /**
   * Read in the conversation this board is a view of.
   *
   * The await is load-bearing. `getConversation` answers with a live but empty
   * conversation for one this viewer has never opened, and an empty transcript
   * is indistinguishable from an empty conversation. `switchConversation` is
   * deliberately not how this is done: it saves the session, and the session's
   * active conversation is the one every future viewer of this project opens on
   * — a board is a second view of a conversation, not a vote for it.
   * @returns {Promise<void>}
   * @private
   */
  async _openBoardConversation() {
    const conversationId = boardConversationId();
    const session = /** @type {any} */ (this._session);
    if (!conversationId || !session) {
      this._boardState = 'missing';
      this._render();
      return;
    }
    if (typeof session.ensureConversationLoaded === 'function') {
      try {
        await session.ensureConversationLoaded(conversationId);
      } catch (err) {
        console.error('[Pinboard] Could not read the conversation this board is a view of:', err);
      }
    }
    this._boardState = session.getConversation?.(conversationId) ? 'ready' : 'missing';
    this._render();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._closePicker?.();
    this._closePicker = null;
    this._unsubscribeSession?.();
    this._unsubscribeSession = null;
  }

  /**
   * Supply the session the active-context snapshot is read from.
   * @param {import('../model/session.js').default} session - The viewer's session.
   * @returns {void}
   */
  setSession(session) {
    if (this._session === session) return;
    this._unsubscribeSession?.();
    this._session = session;
    this._content?.setSession(session);
    // The session arrives after the element is built, so this is the first
    // moment a board can go looking for the conversation it exists to show.
    if (isPinboardView() && session) void this._openBoardConversation();
    this._unsubscribeSession = session
      ? /** @type {() => void} */ (session.subscribe(/** @param {{type: string}} event */ (event) => {
        switch (event.type) {
          case 'session:loaded':
          case 'conversation:switched':
          case 'conversation:renamed':
          case 'conversation:created':
          case 'conversation:deleted':
            this._render();
            break;
          default:
            break;
        }
      }))
      : null;
    this._render();
  }

  /**
   * Move focus into the board, so Escape and the Back button have somewhere to
   * dismiss from and the keyboard is already here.
   *
   * The pin's body, not the selected tab. A tab is a control, and focusing one
   * rings it: WebKit treats a programmatic focus as keyboard-driven, so opening
   * the board with the pointer drew a focus ring nobody had asked for. The body
   * is a region — focusable, not a tab stop, and deliberately unringed — so
   * focus arrives with nothing selected, and Tab from there still reaches the
   * strip for anyone who wants it.
   * @returns {void}
   */
  focusInto() {
    this._content?.focusBody();
  }

  /**
   * Build the three bands once.
   * @private
   */
  _build() {
    if (this._tabbar) return;

    // The toolbar names the surface and carries the controls that put it away.
    // A board window needs none of it: the window frame is the chrome, its own
    // header already says what is being shown, and both controls are
    // meaningless there — a board in a window has nothing to pop out of, and
    // closing it would leave an empty frame the window's own controls already
    // handle. Built here, the band would be a full-width strip reading
    // "Pinboard" directly beneath a header reading "Pinboard".
    const toolbar = isPinboardView() ? null : this._buildToolbar();

    const tabbar = document.createElement('pinboard-tabbar');
    const content = document.createElement('pinboard-content');

    const placeholder = document.createElement('div');
    placeholder.className = 'pinboard-placeholder';
    placeholder.hidden = true;

    const status = document.createElement('div');
    status.className = 'pinboard-panel__status';
    status.setAttribute('role', 'status');
    status.hidden = true;

    if (toolbar) this.append(toolbar);
    this.append(tabbar, content, placeholder, status);
    this._tabbar = tabbar;
    this._content = content;
    this._placeholder = placeholder;
    this._status = status;
    // setSession can land before this element is connected, so hand over
    // whatever is already held rather than relying on that call's own push.
    /** @type {any} */ (content).setSession(this._session);

    this.on(this, 'pinboard-select', (e) => {
      pinboardView.setActivePin(/** @type {CustomEvent} */ (e).detail.pinId);
    });
    this.on(this, 'pinboard-remove', (e) => {
      void pinboardView.remove(/** @type {CustomEvent} */ (e).detail.pinId);
    });
    this.on(this, 'pinboard-move', (e) => {
      const { pinId, index } = /** @type {CustomEvent} */ (e).detail;
      const bounded = Math.max(0, Math.min(pinboardStore.get().length - 1, index));
      void pinboardView.move(pinId, bounded);
    });
    this.on(this, 'pinboard-add', () => this._openPicker());

    // The other half of a detached board lives here: this viewer carries out the
    // reveals its boards send back. It is registered whether or not this
    // viewer's own board is open — a board has to keep working while the window
    // it was detached from has the overlay shut.
    if (!isPinboardView()) {
      ownerLink.serve({ onReveal: (target) => { void this._revealForBoard(target); } });
    }
  }

  /**
   * Carry out one board's reveal in this window's columns.
   *
   * A board stays on the conversation it was opened for while this window goes
   * wherever the user goes, so the two disagreeing is the ordinary case and not
   * a mistake to refuse. Being pointed at something is a request to go and look
   * at it: switch to the conversation the board names, then point.
   * @param {{kind: string, id: string|null, conversation: string}} target - What to reveal.
   * @returns {Promise<void>}
   * @private
   */
  async _revealForBoard(target) {
    // Raised first, and not at the end. A window nobody is looking at has its
    // timers throttled, so the wait below can take a second there — and a window
    // that comes forward a second after the click looks like a window that
    // ignored it.
    raiseThisWindow();
    const session = /** @type {any} */ (this._session);
    const wanted = target.conversation;
    if (wanted && session?.getConversation?.(wanted) && session.getVisibleConversation?.()?.id !== wanted) {
      // Hydrate before switching: a column built from an unloaded conversation
      // has no thread to point at yet, and the reveal would land on nothing.
      await session.ensureConversationLoaded?.(wanted);
      if (!session.switchConversation?.(wanted)) return;
      await waitForTab(wanted);
    }
    revealInConversation(target);
  }

  /**
   * The board's top band, for a board sharing a window with everything else: it
   * names the surface, and holds the two controls that move or close it.
   * @returns {HTMLElement} The toolbar.
   * @private
   */
  _buildToolbar() {
    const toolbar = document.createElement('div');
    toolbar.className = 'pinboard-toolbar';

    const identity = document.createElement('span');
    identity.className = 'pinboard-toolbar__identity';
    identity.textContent = 'Pinboard';

    const controls = document.createElement('div');
    controls.className = 'pinboard-toolbar__controls';

    // A viewer nothing can address — a peer-to-peer one, whose channel opens
    // with no request to carry an id — could not be followed by the board it
    // opened. Whether this viewer has an address is not yet known here: the id
    // arrives on the session frame, and this runs while the page is still being
    // parsed. So the button is built now and shown once the answer is in,
    // rather than asked a question that only ever has one answer this early.
    const popOut = document.createElement('button');
    popOut.type = 'button';
    popOut.className = 'u-btn-ghost pinboard-toolbar__popout';
    popOut.title = 'Open this board in its own window';
    popOut.setAttribute('aria-label', 'Pop out Pinboard');
    popOut.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" aria-hidden="true"><path d="${POPOUT_ICON_PATH}"/></svg><span>Pop-out</span>`;
    popOut.hidden = !canLinkBoards();
    this.on(popOut, 'click', () => { void this._popOut(); });
    controls.appendChild(popOut);
    this._popOutButton = popOut;
    this.addCleanup(onLinkAvailability(() => this._syncPopOut()));

    const close = document.createElement('button');
    close.type = 'button';
    // The app's close button, glyph and all: a surface that puts itself away
    // should not have a private way of saying so.
    close.className = 'close-button';
    close.title = 'Close Pinboard';
    close.setAttribute('aria-label', 'Close Pinboard');
    close.innerHTML = '<span class="icon-close"></span>';
    this.on(close, 'click', () => pinboardView.close());
    controls.appendChild(close);

    toolbar.append(identity, controls);
    return toolbar;
  }

  /**
   * Say what this window is showing, in the strip the window frame leaves behind.
   *
   * Only a board window has anything to put there — in the ordinary view the
   * header is the app's own and the panel is a guest in it. The element lives
   * outside this component because it belongs to the window rather than to the
   * board, and the board is the only thing that knows which conversation and
   * which pin are up.
   *
   * Three parts, answering three questions: what this window is, which
   * conversation it is stuck to, and which pin is showing. The conversation
   * leads the two names because it is the one thing about the window that never
   * changes — and the one thing nothing else on screen says. Either name is
   * dropped when there is none.
   * @param {string} conversationTitle - The conversation's name, or '' for none.
   * @param {string} pinTitle - The pin's name, or '' for a board on no pin.
   * @private
   */
  _nameWindow(conversationTitle, pinTitle) {
    if (!isPinboardView()) return;
    const slot = document.getElementById('board-title');
    if (!slot) return;

    const kind = document.createElement('span');
    kind.className = 'app-header__board-kind';
    kind.textContent = 'Pinboard';
    /** @type {HTMLElement[]} */
    const parts = [kind];
    if (conversationTitle) {
      const conversation = document.createElement('span');
      conversation.className = 'app-header__board-conversation';
      conversation.textContent = conversationTitle;
      parts.push(conversation);
    }
    if (pinTitle) {
      const name = document.createElement('span');
      name.className = 'app-header__board-name';
      name.textContent = pinTitle;
      parts.push(name);
    }
    slot.replaceChildren(...parts);
  }

  /**
   * Offer Pop-out exactly when a board opened from here could find its way back.
   * @private
   */
  _syncPopOut() {
    if (this._popOutButton) this._popOutButton.hidden = !canLinkBoards();
  }

  /**
   * Open this board again in a window of its own, on the pin being read and the
   * conversation being shown, and put the overlay away behind it.
   *
   * The conversation is taken here, at the moment of the click, and it is what
   * the new window is a view of from then on: this window is free to go
   * anywhere afterwards. A pop-out that did not happen leaves the board where it
   * was, with the complaint under it.
   * @private
   */
  async _popOut() {
    const active = this._activeContext();
    // The new window starts as a copy of this panel, so detaching changes
    // nothing about what is on screen — it puts what is on screen into a window,
    // which is what the word says. The two go their own ways from there.
    const complaint = await ownerLink.detach(
      pinboardView.getActivePinId() || '',
      active.conversation?.id || '',
      pinboardStore.get(),
    );
    pinboardView.setStatus(complaint);
    if (!complaint) pinboardView.close();
  }

  /**
   * Draw the board as it stands.
   * @private
   */
  _render() {
    if (!this._tabbar || !this._content) return;
    // A board window is the window, so it is on screen for as long as it
    // exists. The docked panel is put away with a transform and stays in the
    // document, and the pin mounted in it has no other way to be told.
    this._content.setVisible(isPinboardView() || pinboardView.isOpen());
    if (this._renderBoardState()) return;
    const pins = pinboardStore.get();
    const active = this._activeContext();
    const json = JSON.stringify(active);
    const contextChanged = json !== this._contextJson;
    this._contextJson = json;

    const activeId = pinboardView.getActivePinId();
    this._tabbar.setTabs(
      pins.map((pin) => {
        const described = describePin(pin, active);
        return { id: pin.id, title: described.title, badge: described.badge };
      }),
      activeId,
    );

    const activePin = pins.find((pin) => pin.id === activeId) || null;
    this._nameWindow(active.conversation?.title || '', activePin ? describePin(activePin, active).title : '');
    const mounted = this._content.setPin(activePin, active);
    // A pin that was already mounted takes the new snapshot in place; one that
    // has just been mounted was given it already.
    if (contextChanged && !mounted) this._content.setActiveContext(active);

    const status = pinboardView.getStatus();
    if (this._status) {
      this._status.textContent = status;
      this._status.hidden = !status;
    }
  }

  /**
   * Show a detached board's two other states in place of the board.
   *
   * A board still opening its conversation, or one whose conversation is not in
   * this project, is not an empty board — it is a board with nothing to be a
   * view of. Both say so rather than drawing tabs against a transcript nobody
   * can read.
   * @returns {boolean} True when the board itself was not drawn.
   * @private
   */
  _renderBoardState() {
    const placeholder = this._placeholder;
    if (!placeholder) return false;
    const showing = isPinboardView() && this._boardState !== 'ready';

    placeholder.hidden = !showing;
    this._tabbar.hidden = showing;
    this._content.hidden = showing;
    if (!showing) return false;
    // Nothing may still be reading against a conversation this board cannot
    // show: a pin left mounted here would go on polling for one, and a tab left
    // standing would name it.
    this._contextJson = '';
    this._tabbar.setTabs([], null);
    this._content.setPin(null, this._activeContext());
    // The pin is named by the URL that opened this window, so the header can say
    // what the board is for before the conversation has been read at all.
    const pending = pinboardStore.get().find((pin) => pin.id === pinboardView.getActivePinId()) || null;
    this._nameWindow('', pending ? describePin(pending, null).title : '');

    const line = document.createElement('p');
    line.className = 'pinboard-placeholder__line';
    line.textContent = this._boardState === 'missing'
      ? 'That conversation has gone.'
      : 'Opening the conversation.';
    placeholder.replaceChildren(line);
    if (this._boardState === 'missing') {
      const note = document.createElement('p');
      note.className = 'pinboard-placeholder__note';
      note.textContent = 'A board stays on the one conversation it was opened for.';
      placeholder.appendChild(note);
    }
    return true;
  }

  /**
   * Tear every mounted pin down and build it again — what an extension reload
   * needs, since the class behind each pin has been replaced.
   * @private
   */
  _remount() {
    this._contextJson = '';
    this._content?.setPin(null, this._activeContext());
    this._render();
  }

  /**
   * The immutable snapshot every item type is rendered against.
   *
   * One substitution makes a detached board what it is: the conversation is the
   * one its URL names rather than the one this viewer is showing, and the thread
   * is that conversation's root. A board has no columns and follows no reader,
   * so there is no thread being looked at here to report — and a board that
   * reported this window's own visible conversation would be a second, quieter
   * view of whatever the app is doing, which is the one thing it must not be.
   * @returns {PinActiveContext} Project, conversation and thread as they stand.
   * @private
   */
  _activeContext() {
    const session = /** @type {any} */ (this._session);
    const path = session?.projectPath || '';
    const project = { path, displayName: baseName(path) };
    if (isPinboardView()) {
      const conversation = session?.getConversation?.(boardConversationId()) || null;
      return {
        project,
        conversation: conversation ? { id: conversation.id, title: conversation.name || '' } : null,
        thread: conversation ? { id: null } : null,
      };
    }
    const conversation = session?.getVisibleConversation?.() || null;
    return {
      project,
      conversation: conversation ? { id: conversation.id, title: conversation.name || '' } : null,
      thread: conversation ? { id: focusedThreadId() } : null,
    };
  }

  /**
   * Open the add picker against whichever control asked for it.
   * @private
   */
  _openPicker() {
    this._closePicker?.();
    const anchor = /** @type {HTMLElement|null} */ (this._tabbar?.getAddButton());
    if (!anchor) return;
    this._closePicker = openAddPicker({
      anchor,
      active: this._activeContext(),
      onPick: (typeId) => {
        this._closePicker = null;
        void this._add(typeId);
      },
    });
  }

  /**
   * Add a pin of a type, giving the item type its chance to ask for a config
   * first. A picker the user backed out of is not an error.
   * @param {string} typeId - The chosen item-type id.
   * @returns {Promise<void>}
   * @private
   */
  async _add(typeId) {
    const type = pinboardItemRegistry.getType(typeId);
    if (!type) return;
    /** @type {Record<string, any>|null} */
    let config = {};
    const abort = new AbortController();
    try {
      config = await type.configure({ active: this._activeContext(), signal: abort.signal });
    } catch (err) {
      pinboardView.setStatus(`Couldn't add that pin. ${extractErrorMessage(err)}`);
      return;
    }
    if (config === null) return;
    await pinboardView.add(typeId, config);
  }
}

customElements.define('pinboard-panel', PinboardPanel);

export default PinboardPanel;
