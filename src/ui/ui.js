/**
 * Ui -- Composition Root / DI Container for the UI.
 *
 * Creates all child instances (layout manager, windows, status bar, input)
 * and wires them together. No singletons -- everything is instantiated here
 * and dependencies are injected via constructors.
 *
 * Dependencies: receives `term` in init().
 *
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */
'use strict'

import process from 'node:process'

import ConfigService from '../service/configService.js'
import StateService from '../service/stateService.js'
import LoggerService from '../service/loggerService.js'

// Layout
import UiLayoutManager from './layout/uiLayoutManager.js'

// Channels
import channels from './channels.js'

// Commands
import CommandContainer from './commands/container/commandContainer.js'

// Windows
import LogWindow from './windows/logWindow.js'
import DeviceWindow from './windows/deviceWindow.js'
import AiWindow from './windows/aiWindow.js'

// Widgets
import StatusBar from './widgets/statusBar.js'
import InputComponent from './widgets/inputComponent.js'

// ---------------------------------------------------------------------------
// Ui
// ---------------------------------------------------------------------------

/**
 * Composition root and DI container for the terminal UI.
 * Creates all child instances (layout manager, windows, status bar, input),
 * wires them together, and manages window switching via keyboard shortcuts.
 */
class Ui {

    #term
    #layout
    #activeWindow = null
    #windows = {}
    #statusBar
    #input
    #running = false
    #channelShortcutMap = {}  // id -> shortcut mapping
    #commandContext = null     // context object injected into pluggable commands

    // -- Initialization ---------------------------------------------------

    /**
     * Initialize the UI application. Called after all services are ready.
     * @param {*} term - The terminal-kit terminal instance
     */
    async init(term) {
        this.#term = term

        if (!this.#term) {
            throw new Error('Ui.init() requires a valid terminal instance')
        }

        LoggerService.debug(`UI Resolved term object: ${term.constructor?.name}`, 'UI')

        // Enable raw input mode -- required for key events and InlineInput to work over SSH
        try {
            this.#term.grabInput()
        } catch (e) {
            LoggerService.warn(`grabInput failed: ${e.message}`, 'UI')
        }

        // Create layout manager
        this.#layout = new UiLayoutManager(this.#term)

        // Load channel definitions from config and create windows dynamically
        const allChannels = channels.getAll()
        const windowConstructors = {
            logs: LogWindow,
            device: DeviceWindow,
            ai: AiWindow,
        }

        let firstChannelId = null
        for (const ch of allChannels) {
            firstChannelId = firstChannelId || ch.id
            this.#channelShortcutMap[ch.id] = ch.shortcut

            const Ctor = windowConstructors[ch.id]
            if (!Ctor) continue

            // AiWindow needs the channel name too
            const instance = (ch.id === 'ai')
                ? new Ctor(this.#term, this.#layout, ch.shortcut, ch.channel)
                : new Ctor(this.#term, this.#layout, ch.shortcut)

            this.#windows[ch.id] = {
                instance,
                title: ch.title,
                channel: ch.channel,
                shortcut: ch.shortcut,
            }
        }

        // Set default active window to the first defined in config
        this.#activeWindow = firstChannelId || 'logs'

        // Apply UI config (buffer limits, etc.) to all windows
        this.#applyUiConfig()

        // Create status bar
        this.#statusBar = new StatusBar(this.#term, this.#layout)
        this.#statusBar.init()

        // KEY ORDER MATTERS: Register key bindings BEFORE input component so that
        // Ui's handler fires first and can mark keys as consumed synchronously.
        // terminal-kit emits to listeners in registration order.
        this.#input = new InputComponent(this.#term, this.#layout)
        this.#input.onCommand((cmd) => this.#handleCommand(cmd))
        this.#setupKeyBindings()  // Must run before this.#input.init()
        this.#input.init()

        await CommandContainer.init(null)

        // Terminal resize handling
        try {
            this.#term.on('resize', () => {
                try {
                    const r = this.#layout.getSlot('main')
                    // Skip render during extreme resize states (height < 5 means
                    // there's barely any room for content + status bar + input).
                    if (!r || r.height < 5 || r.width < 10) return
                    
                    this.#layout.updateSlots()
                    // Force full re-render of active window on resize (wrapping changes)
                    if (this.#activeWindow && this.#windows[this.#activeWindow]) {
                        this.#windows[this.#activeWindow].instance.forceFullRender()
                        this.#windows[this.#activeWindow].instance.render()
                    }
                    this.#statusBar.refresh?.()
                } catch (e) {
                    LoggerService.warn(`Resize handler error: ${e.message}`, 'UI')
                }
            })
        } catch (e) { /* not all terminals support resize events */ }

        this.#running = true
        StateService.set('ui.active', true)

        LoggerService.info(`UI initialized with ${Object.keys(this.#windows).length} channel(s)`, 'UI')

        // Show default window
        this.switchWindow(this.#activeWindow)

        // Attach Winston transport to log window
        const logWin = this.#windows['logs']?.instance
        if (logWin) {
            LoggerService.addTransport(logWin.getTransport())
        }
    }

    // -- Public API -------------------------------------------------------

    /**
     * Switch to a named window by ID or numeric shortcut.
     * @param {string|number} idOrShortcut - Window ID ('logs', 'device', 'ai') or shortcut number
     */
    switchWindow(idOrShortcut) {
        let targetId = String(idOrShortcut)

        // Resolve numeric shortcut to internal ID
        for (const [chId, shortcut] of Object.entries(this.#channelShortcutMap)) {
            if (String(shortcut) === targetId) {
                targetId = chId
                break
            }
        }

        if (!this.#windows[targetId]) return

        // Hide current window
        const prev = this.#activeWindow
        if (prev && this.#windows[prev]) {
            this.#windows[prev].instance.hide()
        }

        // Show new window
        this.#activeWindow = targetId
        this.#windows[targetId].instance.show()

        // Notify status bar of active window for activity indicator
        this.#statusBar.notifyActiveWindow?.(this.#channelShortcutMap[targetId])
        
        // Update backscroll indicator in status bar
        const win = this.#windows[targetId]?.instance
        if (win && this.#statusBar.notifyBackscrolled) {
            this.#statusBar.notifyBackscrolled(win.isBackscrolled?.())
        }

        // Update input prompt with channel name
        this.#input.setChannel?.(channels.getChannelName(targetId))
    }

    /**
     * Return the Winston transport for the log window so external code
     * (e.g., main.js) can attach it early before full init completes.
     * @returns {winston.Transport|null}
     */
    getLogTransport() {
        const logWin = this.#windows?.logs?.instance
        return logWin?.getTransport?.() ?? null
    }

    /**
     * Clean up all UI resources without exiting the process.
     * Called by main.js during its sequential graceful shutdown sequence.
     * Does NOT call process.exit() -- that is the responsibility of main.js.
     */
    cleanup() {
        if (!this.#running) return
        this.#running = false

        LoggerService.info('UI cleaning up...', 'UI')
        StateService.set('ui.active', false)

        // Destroy all windows first
        for (const win of Object.values(this.#windows)) {
            win.instance.destroy?.()
        }

        // Hide and destroy status bar
        this.#statusBar.hide?.()
        this.#statusBar.destroy?.()

        // Destroy input component
        this.#input.destroy?.()

        // Release raw input mode & reset terminal
        if (this.#term) {
            try {
                this.#term.grabInput(false)
            } catch { /* ignore */ }
            this.#term.styleReset()
            
            // Clear the input slot row so the channel prompt ([!log], etc.) 
            // doesn't remain visible in the terminal after exit.
            this.#layout.moveToSlot('input')
            this.#term.eraseLine()
            this.#layout.moveToSlot('input')
            this.#term.nextLine()
            this.#term('\n')
        }
    }

    /**
     * External destroy hook called by main.js gracefulDeath.
     */
    destroy() {
        this.cleanup()
    }

    // -- Callbacks --------------------------------------------------------

    /**
     * Handle commands typed at the bottom prompt.
     * Routes input based on the active window's inputMode:
     *   - 'chat'    -> send directly to AI (no log)
     *   - 'command' -> log + auto-prefix with / as slash-command
     * @param {string} cmd - Raw command string from the input component
     */
    #handleCommand(cmd) {
        const activeWin = this.#windows[this.#activeWindow]?.instance
        const mode = activeWin?.constructor?.inputMode || 'command'

        // -- Chat mode: send directly to AI, no log -----------------------
        if (mode === 'chat') {
            return this.#windows.ai?.instance?.submitMessage(cmd).catch(err => {
                LoggerService.error(`AI submit failed: ${err.message}`, 'UI')
            })
        }

        // -- Command mode: log + treat as slash-command --------------------
        LoggerService.info(`UI Received Command: "${cmd}"`, 'UI')

        // Auto-prefix plain text with / so it's treated as a slash-command
        const processedCmd = cmd.startsWith('/') ? cmd : '/' + cmd

        // Dynamic shortcut handling based on channel config
        const allChannels = channels.getAll()
        for (const ch of allChannels) {
            if (new RegExp(`^\\/${ch.shortcut}\\s*$`).test(processedCmd)) {
                return this.switchWindow(ch.id)
            }
        }

        const parts = processedCmd.split(/\s+/)
        const verb = parts[0]?.toLowerCase().replace(/^\/+/, '') || ''
        const arg = parts.slice(1).join(' ')

        switch (verb) {
            case 'quit':
            case 'exit':
            case 'q':
                this.shutdown()
                break

            case 'clear':
                if (this.#activeWindow && this.#windows[this.#activeWindow]) {
                    this.#windows[this.#activeWindow].instance.clear()
                }
                break

            case 'help':
                if (this.#activeWindow && this.#windows[this.#activeWindow]) {
                    const win = this.#windows[this.#activeWindow].instance
                    const shortcuts = allChannels.map(c => `  /${c.shortcut}       ${c.channel}`).join('\n')
                    win.print('\nAvailable commands:\n' +
                        shortcuts + '\n' +
                        '  /clear          Clear current window\n' +
                        '  /pgup           Page up (scroll back)\n' +
                        '  /pgdn           Page down (scroll forward)\n' +
                        '  /status         Show system status\n' +
                        '  /quit           Exit automaton\n')
                }
                break

            case 'pgup':
            case 'pageup':
                if (this.#activeWindow && this.#windows[this.#activeWindow]) {
                    this.#windows[this.#activeWindow].instance.scrollPageUp?.()
                }
                break

            case 'pgdn':
            case 'pagedown':
                if (this.#activeWindow && this.#windows[this.#activeWindow]) {
                    this.#windows[this.#activeWindow].instance.scrollPageDown?.()
                }
                break

            case 'status':
                if (this.#activeWindow && this.#windows[this.#activeWindow]) {
                    const win = this.#windows[this.#activeWindow].instance
                    const dump = StateService.dump()
                    const entries = Object.entries(dump)
                        .filter(([k, v]) => v != null && v !== '')
                        .map(([k, v]) => `  ${k} = ${typeof v === 'object' ? JSON.stringify(v) : v}`)
                    win.print('\nSystem Status:\n' + (entries.length ? entries.join('\n') : '  (no active states)\n'))
                }
                break

            default:
                // Delegate unknown verbs to pluggable command container
                CommandContainer.execute(verb, arg).catch(() => {})
                // Unknown slash-command in command-mode window - just ignore
                break
        }
    }

    // -- Private Helpers --------------------------------------------------

    /**
     * Load automaton.yaml configuration and apply it to window instances.
     * @private
     */
    #applyUiConfig() {
        try {
            const maxBufferLines = ConfigService.get('window_settings.max_buffer_lines')
            if (typeof maxBufferLines === 'number' && maxBufferLines > 0) {
                for (const win of Object.values(this.#windows)) {
                    win.instance.setMaxBufferLines?.(maxBufferLines)
                }
                LoggerService.debug(`UI Buffer limit set to ${maxBufferLines} per window`, 'UI')
            }
        } catch (e) {
            LoggerService.warn(`Failed to apply UI config: ${e.message}`, 'UI')
        }
    }

    /**
     * Set up Alt+number keyboard bindings based on channel shortcuts from config.
     * Also handles PgUp/PgDown for scroll navigation.
     *
     * Over SSH xterm-256color, Alt+N arrives as TWO key events:
     *   ESCAPE  then  "N"
     * We detect ESCAPE and wait for the next key within a short timeout.
     */
    #setupKeyBindings() {
        if (!this.#term) return

        let escapeTimer = null
        let expectingEscapeKey = false

        // Build a shortcut->id map for quick lookup
        const shortcutToId = {}
        for (const ch of channels.getAll()) {
            shortcutToId[String(ch.shortcut)] = ch.id
        }

        try {
            this.#term.on('key', (name, data) => {
                // Normalize -- terminal-kit sends UPPERCASE over SSH xterm-256color
                const n = name.toLowerCase()

                // --- PgUp / PgDown for scroll navigation --------------------
                if (n === 'page_up' || n === 'pageup' || n === 'pgup') {
                    if (this.#activeWindow && this.#windows[this.#activeWindow]) {
                        this.#input.markConsumed([n, name])
                        const win = this.#windows[this.#activeWindow].instance
                        win.scrollPageUp?.()
                        if (this.#statusBar.notifyBackscrolled) {
                            this.#statusBar.notifyBackscrolled(win.isBackscrolled?.())
                        }
                    }
                    return
                }
                if (n === 'page_down' || n === 'pagedown' || n === 'pgdn') {
                    if (this.#activeWindow && this.#windows[this.#activeWindow]) {
                        this.#input.markConsumed([n, name])
                        const win = this.#windows[this.#activeWindow].instance
                        win.scrollPageDown?.()
                        if (this.#statusBar.notifyBackscrolled) {
                            this.#statusBar.notifyBackscrolled(win.isBackscrolled?.())
                        }
                    }
                    return
                }

                // --- Detect ESCAPE prefix for Alt+ shortcuts ----------------
                if (n === 'escape') {
                    expectingEscapeKey = true
                    clearTimeout(escapeTimer)
                    // If no follow-up key within 100ms, treat as standalone Escape
                    escapeTimer = setTimeout(() => {
                        expectingEscapeKey = false
                    }, 100)
                    return
                }

                // --- After ESCAPE, check for digit to switch windows --------
                if (expectingEscapeKey) {
                    expectingEscapeKey = false
                    clearTimeout(escapeTimer)

                    const targetChId = shortcutToId[n]
                    if (targetChId) {
                        this.#input.markConsumed([n, name])
                        this.switchWindow(targetChId)
                        return
                    }
                    // Not a recognized shortcut -- clear consumed and let InputComponent handle it
                    this.#input.clearConsumed()
                    return
                }

                // Ctrl+C shutdown -- normalize to handle both CTRL_C and ctrl_c
                if (n === 'ctrl_c' || n === 'ctrlc') {
                    LoggerService.info('UI Shutdown requested via CTRL_C', 'UI')
                    this.shutdown()
                }
            })
        } catch (e) {
            LoggerService.warn(`Key binding setup failed: ${e.message}`, 'UI')
        }
    }

    /**
     * Graceful shutdown: clean up UI then exit the process.
     * Called only when the user directly requests quit from within the UI
     * (e.g., /quit command or Ctrl+C).
     */
    shutdown() {
        this.cleanup()
        LoggerService.info('UI shutting down...', 'UI')
        process.exit(0)
    }
}

export default Ui