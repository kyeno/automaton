/**
 * JSDoc plugin to automatically assign proper module names from file paths.
 *
 * Handles two cases:
 *   1. Unnamed modules (longname = "module") — rename to path-based module name
 *   2. Orphaned "exports"/"module.exports" classes — reclassify as members of
 *      their path-derived module instead of floating as top-level entries.
 */
'use strict'

const PATH_RE = /src[/\\](.+?)(?:\.js)?$/i

exports.handlers = {
  newDoclet(e) {
    const doclet = e.doclet
    if (!doclet || !doclet.meta) return

    // --- Case 1: unnamed module -------------------------------------------
    if (doclet.kind === 'module') {
      const name = String(doclet.longname || '')
      if (name && name !== 'module' && !name.startsWith('module:')) return

      const filePath = `${doclet.meta.path}/${doclet.meta.filename}`
      const m = filePath.match(PATH_RE)
      if (m) {
        doclet.longname = `module:${m[1].replace(/\\/g, '/')}`
      }
      return
    }

    // --- Case 2: orphaned class named "exports" or "module.exports" --------
    // These appear when a file exports a default without an explicit @module tag.
    // JSDoc creates them as kind="class" with longname like "module.exports".
    const longname = String(doclet.longname || '')
    if (longname === 'module.exports' || longname === 'exports' || longname === 'module#.exports') {
      const filePath = `${doclet.meta.path}/${doclet.meta.filename}`
      const m = filePath.match(PATH_RE)
      if (m) {
        const modName = m[1].replace(/\\/g, '/')
        // Convert the orphaned export into a proper module member
        doclet.kind = 'member'
        doclet.memberof = `module:${modName}`
        doclet.longname = `${modName}.default`
        doclet.name = 'default'
      }
    }
  }
}