/**
 * ChatMessageOrigin -- authorship provenance for AI chat messages.
 * Determines who authored a message in the conversation history, allowing.
 * @module enum/aiChatMessageOrigin
 * Copyright (C) 2026 Ratan M. Kyeno <matt@prayam.com>
 * Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
 * @author Ratan M. Kyeno
 * @license AGPL-3.0-only
 */

'use strict'

/** Message origin constants indicating the author of a chat message.
 * @readonly
 * @enum {string} */
const ChatMessageOrigin = Object.freeze({
    USER: 'user',
    SYSTEM: 'system'
})

export default ChatMessageOrigin