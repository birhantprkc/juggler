//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Global type declarations for Juggler
 */

interface Window {
	/**
	 * Show an alert dialog
	 */
	showAlert(message: string, title?: string): Promise<void>;

	/**
	 * Show a confirm dialog
	 */
	showConfirm(
		message: string,
		title?: string,
		options?: { confirmText?: string; cancelText?: string; danger?: boolean }
	): Promise<boolean>;

	/**
	 * Show a prompt dialog
	 */
	showPrompt(message: string, defaultValue?: string, title?: string): Promise<string | null>;

	/**
	 * Marked markdown parser (loaded from vendor)
	 */
	marked?: {
		parse(markdown: string): string;
	};

	/**
	 * Reference to main application instance (debugging)
	 */
	jugglerApp?: unknown;

	/**
	 * Show choice dialog
	 */
	showChoice?(message: string, choices: string[], title?: string, allowCustom?: boolean): Promise<string | null>;

	/**
	 * Open settings panel
	 * @param tab - Optional tab to switch to ('providers', 'shortcuts', 'facts')
	 */
	openSettings?(tab?: string): void;

	/**
	 * Test completion flag (for headless testing)
	 */
	testComplete?: boolean;

	/**
	 * Set by server when running in test mode; causes app.js to poll for pending tests.
	 */
	JUGGLER_TEST_MODE?: boolean;

}

/**
 * Custom element type extensions
 */
interface HTMLElementTagNameMap {
	'conversation-area': HTMLElement & {
		conversation: unknown;
		transactions: unknown[];
		scrollToBottom(force?: boolean): void;
		scrollFollowTargetIntoView(force?: boolean): void;
		updateSpinner(show: boolean): void;
		showError(error: string): void;
		hideRetryNotification(): void;
		showRetryNotification(error: string, onRetry: () => void): void;
		renderFromItems(items: unknown[], insertedMessageIds?: string[]): void;
		inputBox?: HTMLElement;
	};
	'model-selector': HTMLElement & {
		refresh(): void;
		setSession(session: unknown): void;
	};
	'plugin-catalog': HTMLElement & {
		show(scope: 'global' | 'local'): void;
	};
	'input-box': HTMLElement & {
		setSession(session: unknown): void;
		focus(): void;
	};
	'properties-panel': HTMLElement & {
		setConversation(conversation: unknown): void;
		selectItem(itemId: string | null): void;
		clearSelection(): void;
		getSelectedItemId(): string | null;
	};
}

