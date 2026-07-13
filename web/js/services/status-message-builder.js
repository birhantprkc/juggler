//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * @file StatusMessageBuilder - Centralized status message formatting for busy spinner
 * Provides consistent formatting for all status scenarios during LLM processing
 */

/**
 * @typedef {object} StreamingStatusData
 * @property {number} [inputTokens] - Tokens sent to LLM
 * @property {number} [outputTokens] - Tokens received from LLM
 * @property {number} [cachedTokens] - Prompt tokens served from cache (OpenAI)
 * @property {number} [elapsedTime] - Elapsed time in milliseconds
 * @property {string} [phase] - Provider-emitted phase label shown before the first token (e.g. "Starting Claude Code", "Waiting for response")
 */

/**
 * @typedef {object} RetryStatusData
 * @property {number} attempt - Current retry attempt
 * @property {number} maxRetries - Maximum retry attempts
 * @property {string} [reason] - Reason for retry (timeout, network, etc.)
 * @property {number} [elapsedTime] - Elapsed time in milliseconds
 */

/**
 * @typedef {object} UploadingStatusData
 * @property {number} payloadSize - Payload size in bytes
 * @property {number} [elapsedTime] - Elapsed time in milliseconds
 */

/**
 * Builds consistent status messages for the busy spinner
 */
export class StatusMessageBuilder {
  /**
   * Trailing marker that signals an in-progress action (e.g. "Receiving…").
   *
   * This is the SINGLE control point for the busy ellipsis across every
   * spinner / footer status message. The individual status strings are authored
   * WITHOUT any ellipsis; the marker is added once at the render seam via
   * withBusyMarker(). Set this to '' to render every status with no trailing
   * ellipsis at all.
   * @type {string}
   */
  static busyMarker = '';

  /**
   * Decorate a fully-built status message with the in-progress marker. Status
   * strings bubble up from the builders unadorned; this is applied once at the
   * render seam (see LLMState.getStatusMessage) so the marker is purely
   * presentational and the stored message stays bare. Any ellipsis a message
   * already carries (unicode '…' or three dots) is normalised away first, so
   * this is the single point that decides both the style and whether the marker
   * appears at all. With `busyMarker` set to '' it strips any stray ellipsis and
   * adds none.
   * @param {string} message - A built status message (no trailing ellipsis expected)
   * @returns {string} The message with the single busy marker applied
   */
  static withBusyMarker(message) {
    if (!message) return message;
    const bare = message.replace(/\s*(\u2026|\.\.\.)\s*$/, '');
    return StatusMessageBuilder.busyMarker ? `${bare}${StatusMessageBuilder.busyMarker}` : bare;
  }

  /**
   * Format elapsed time compactly.
   * Examples: "3s", "45s", "3m 14s", "2h 15m"
   * @param {number} milliseconds - Elapsed time in milliseconds
   * @returns {string} Formatted elapsed time
   * @private
   */
  static _formatElapsedTime(milliseconds) {
    if (milliseconds < 1000) {
      return '0s';
    }

    const totalSeconds = Math.floor(milliseconds / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    } else {
      return `${seconds}s`;
    }
  }

  /**
   * Join a status label with the optional elapsed-time suffix. Shared by the
   * builders whose message is just "<label> · <elapsed>".
   * @param {string} label - The status label (authored without ellipsis)
   * @param {{elapsedTime?: number}} [data] - Optional data with elapsed time
   * @returns {string} Formatted status message
   * @private
   */
  static _withElapsed(label, data = {}) {
    const parts = [label];
    if (data.elapsedTime !== undefined) {
      parts.push(this._formatElapsedTime(data.elapsedTime));
    }
    return parts.join(' · ');
  }

  /**
   * Builds status message for streaming response
   * @param {StreamingStatusData} data - Streaming status information
   * @returns {string} Formatted status message
   */
  static buildStreamingStatus(data) {
    // Before any output token has streamed, lead with the provider's phase
    // label (e.g. "Starting Claude Code", "Waiting for response") so a slow
    // cold start shows what's actually happening rather than a static
    // "Receiving" that looks jammed. Once tokens arrive, "Receiving" with the
    // running count is the more useful label and takes over. Labels stay
    // unadorned here; the busy marker is added at the render seam.
    const hasOutput = data.outputTokens !== undefined && data.outputTokens > 0;
    const lead = (!hasOutput && data.phase) ? data.phase : 'Receiving';
    const parts = [lead];

    // Append token counts when available; the lead label stays so the user
    // always sees the activity label, with the running number alongside it.
    if (data.outputTokens !== undefined && data.outputTokens > 0) {
      const output = data.outputTokens;
      const input = data.inputTokens;
      const cached = data.cachedTokens;

      if (input !== undefined && input > 0) {
        const totalTokens = input + output;
        const tokenWord = totalTokens === 1 ? 'token' : 'tokens';
        if (cached !== undefined && cached > 0) {
          const cachePercent = Math.round((cached / input) * 100);
          parts.push(`${input.toLocaleString()} (${cachePercent}% cached) → ${output.toLocaleString()} ${tokenWord}`);
        } else {
          parts.push(`${input.toLocaleString()} → ${output.toLocaleString()} ${tokenWord}`);
        }
      } else {
        const tokenWord = output === 1 ? 'token' : 'tokens';
        parts.push(`${output.toLocaleString()} ${tokenWord}`);
      }
    }

    // Add elapsed time if available
    if (data.elapsedTime !== undefined) {
      parts.push(this._formatElapsedTime(data.elapsedTime));
    }

    return parts.join(' · ');
  }

  /**
   * Builds status message for preparing request
   * @param {StreamingStatusData} [data] - Optional data with elapsed time
   * @returns {string} Formatted status message
   */
  static buildPreparingStatus(data = {}) {
    return this._withElapsed('Preparing request', data);
  }

  /**
   * Builds status message for waiting for LLM response
   * @param {StreamingStatusData} [data] - Optional data with elapsed time
   * @returns {string} Formatted status message
   */
  static buildWaitingStatus(data = {}) {
    return this._withElapsed('Waiting for response', data);
  }

  /**
   * Builds status message for uploading context
   * @param {UploadingStatusData} data - Upload status data
   * @returns {string} Formatted status message
   */
  static buildUploadingStatus(data) {
    const sizeKB = Math.ceil(data.payloadSize / 1024);
    return this._withElapsed(`Uploading context ${sizeKB.toLocaleString()} KB`, data);
  }

  /**
   * Builds status message for processing tools
   * @param {StreamingStatusData} [data] - Optional data with elapsed time
   * @returns {string} Formatted status message
   */
  static buildProcessingToolsStatus(data = {}) {
    return this._withElapsed('Processing tools', data);
  }

  /**
   * Builds status message for executing action (approved action running)
   * @param {StreamingStatusData} [data] - Optional data with elapsed time
   * @returns {string} Formatted status message
   */
  static buildExecutingActionStatus(data = {}) {
    return this._withElapsed('Running action', data);
  }

  /**
   * Builds status message for retry attempts
   * @param {RetryStatusData} data - Retry status information
   * @returns {string} Formatted status message
   */
  static buildRetryStatus(data) {
    return this._withElapsed(`Retrying attempt ${data.attempt}/${data.maxRetries}`, data);
  }

  /**
   * Builds status message for errors
   * @param {string} message - Error message
   * @returns {string} Formatted error status message
   */
  static buildErrorStatus(message) {
    return `Error: ${message}`;
  }

  /**
   * Builds status message for cancellation
   * @returns {string} Cancellation status message
   */
  static buildCancelledStatus() {
    return 'Operation cancelled';
  }

  /**
   * Builds status message for custom operations (e.g., compacting, retrying).
   * Custom messages are in-progress labels too, so they take the same busy
   * marker as the built-in labels at the render seam — authored without an
   * ellipsis here.
   * @param {string} message - Required custom message to display
   * @param {StreamingStatusData} [data] - Optional data with elapsed time
   * @returns {string} Formatted status message
   */
  static buildCustomStatus(message, data = {}) {
    return this._withElapsed(message, data);
  }

  /**
   * Builds an empty status (for very brief moments before we know what's happening)
   * @returns {string} Empty status string
   */
  static buildEmptyStatus() {
    return '';
  }
}
