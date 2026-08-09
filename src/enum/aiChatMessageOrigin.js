/**
 * ChatMessageOrigin -- authorship provenance for AI chat messages.
 *
 * Determines who authored a message in the conversation history, allowing
 * the UI to correctly render the sender prefix when restoring persisted
 * conversations from cache:
 *
 *   'user'     -- Human typed the message in the chat input
 *   'system'   -- Periodic system prompt timer triggered the message automatically
 *
 * @module enum/aiChatMessageOrigin
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 *
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */

'use strict'

/**
 * Message origin constants indicating the author of a chat message.
 *
 * @readonly
 * @enum {string}
 */
const ChatMessageOrigin = Object.freeze({
    USER: 'user',
    SYSTEM: 'system'
})

export default ChatMessageOrigin