/** Install an isolated cache for AI tests, with no Redis connection or deployment state. */
import CacheService from '../../src/service/cacheService.js'

export function installMemoryCache() {
    const entries = new Map()
    const proto = Object.getPrototypeOf(CacheService)
    const originals = new Map()
    const methods = {
        isConnected: () => true,
        get: async (key) => {
            const entry = entries.get(key)
            if (!entry || entry.expires <= Date.now()) { entries.delete(key); return null }
            return structuredClone(entry.value)
        },
        set: async (key, value, ttl = 10800) => {
            entries.set(key, { value: structuredClone(value), expires: Date.now() + ttl * 1000 })
            return true
        },
        delete: async (key) => entries.delete(key),
    }
    for (const [key, value] of Object.entries(methods)) {
        originals.set(key, proto[key])
        proto[key] = value
    }
    return () => { for (const [key, value] of originals) proto[key] = value }
}
