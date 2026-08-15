/**
 * TTS Window -- Window 4.
 *
 * Live text-to-speech monitor. Displays every TTS event as it is emitted
 * and forwards any user input directly to the TTS pipeline via EventBus.
 * Extends BaseWindow for consistent buffering and rendering.
 * Styled after classic BitchX/IRC clients.
 *
 * Dependencies: receives `term` and `layout` via constructor.
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import EventBus from '../../service/eventBus.js'
import { tsPrefix } from '../../lib/terminal.js'
import AnsiColors from '../../enum/ansiColors.js'
import BaseWindow from './baseWindow.js'

// ---------------------------------------------------------------------------
// TtsWindow
// ---------------------------------------------------------------------------

/**
 * TTS monitoring window displayed in the terminal UI.
 * Subscribes to 'tts:speak' events so every spoken message appears here
 * with a <TTS> prefix. User input is forwarded straight to the same
 * EventBus channel, triggering both real audio playback and an immediate
 * local echo in this window.
 */
class TtsWindow extends BaseWindow {
    // Treats input as chat messages sent directly to TTS
    static inputMode = 'chat'

    #welcomeShown = false
    #speakUnsub = null
    #channelShortcut
    #channelName

    // -- Initialization ---------------------------------------------------

    /**
     * Create a new TtsWindow instance.
     * @param {*} term - The terminal-kit instance
     * @param {*} layout - UiLayoutManager instance
     * @param {number} channelShortcut - Numeric shortcut from channel config
     * @param {string} channelName - IRC-style channel name (e.g., "#tts")
     */
    constructor(term, layout, channelShortcut = 4, channelName = '#tts') {
        super('TTS', term, layout, channelShortcut)
        this.#channelShortcut = channelShortcut
        this.#channelName = channelName
        this.#subscribeToSpeak()
    }

    // -- Public API -------------------------------------------------------

    /**
     * Override show() to emit a welcome message on first display.
     */
    show() {
        super.show()
        if (!this.#welcomeShown) {
            this.#welcomeShown = true
            if (this.isEmpty) {
                this.#showWelcome()
            }
        }
    }

    /**
     * Send text directly to the TTS pipeline and echo it in this window.
     * Emits activity so the status bar can track it.
     *
     * @param {string} text - User's text to speak
     */
    async submitMessage(text) {
        const trimmed = (text || '').trim()
        if (!trimmed) return

        // Emit to tts:speak -- triggers both real audio playback AND our own subscriber,
        // which renders the message uniformly with a ">" prefix.
        EventBus.emit('tts:speak', { text: trimmed })

        // Emit activity for the status bar
        EventBus.emit('window:activity', this.#channelShortcut)
    }

    /**
     * Destroy this window: unsubscribe from events, hide, and clear.
     */
    destroy() {
        if (this.#speakUnsub) {
            this.#speakUnsub()
            this.#speakUnsub = null
        }
        this.hide()
        this.clear()
    }

    // -- Callbacks --------------------------------------------------------

    /**
     * Subscribe to 'tts:speak' events so every TTS utterance is rendered here.
     * @private
     */
    #subscribeToSpeak() {
        this.#speakUnsub = EventBus.subscribe('tts:speak', ({ text }) => {
            if (!text) return

            this.printMessage(text, `${tsPrefix()} ${AnsiColors.bold}${AnsiColors.yellow}>${AnsiColors.reset} `)
            EventBus.emit('window:activity', this.#channelShortcut)
        })
    }

    // -- Welcome ----------------------------------------------------------

    /**
     * Show IRC-style join/welcome sequence on first display.
     * @private
     */
    #showWelcome() {
        // Action: * TTS monitor has joined the channel.
        this.print(`${tsPrefix()} ${AnsiColors.italic}${AnsiColors.white}* TTS monitor is now active.${AnsiColors.reset}`)
    }
}

export default TtsWindow
