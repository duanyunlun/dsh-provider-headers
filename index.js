/**
 * `dsh-provider-headers` host half: per-conversation expansion of configured
 * request headers.
 *
 * The Harness already sends `llm-pi-ai.providers.<route>.headers` on that
 * route's model requests and on its model-list request, so a header with a
 * constant value needs nothing from this half. A header whose value must differ
 * per conversation cannot be expressed that way: a provider profile is resolved
 * once per route, and every conversation on the route shares it.
 *
 * This half expands one placeholder, `${sessionId}`, to the calling call's
 * session id and attaches the result to the provider's own HTTP requests. The
 * expansion rides `AsyncLocalStorage`: the `llm/stream` listener runs one
 * streaming call inside a scope carrying that call's session id, and a
 * `globalThis.fetch` wrapper installed for this plugin's lifetime reads the
 * scope. A request made outside any scope is passed to the original `fetch`
 * untouched, so no other caller in the process observes the wrapper.
 *
 * Only headers whose configured value contains the placeholder are attached
 * here; constant headers keep travelling through the Harness's own path.
 *
 * @module dsh-provider-headers
 */

import { AsyncLocalStorage } from 'node:async_hooks'

/** Settings namespace owning pi-ai provider profiles. */
const NS = 'llm-pi-ai'

/** Placeholder this half expands to the calling conversation's session id. */
const PLACEHOLDER = '${sessionId}'

/** Header names the Harness owns; a configured value for one is never attached. */
const RESERVED = new Set(['user-agent', 'host', 'content-length'])

/** Per-call transport facts the fetch wrapper reads. */
const callScope = new AsyncLocalStorage()

/**
 * Whether one request target matches the configured host allowlist.
 * @param input - first `fetch` argument.
 * @param hosts - configured host suffixes; empty admits every host.
 * @returns true when the request carries expanded headers.
 */
function hostMatches(input, hosts) {
  if (hosts.length === 0) return true
  let url
  try {
    url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  } catch {
    // A `fetch` input that is neither a string, URL, nor Request is passed
    // through untouched: the wrapper has no host to match against.
    return false
  }
  let hostname
  try {
    hostname = new URL(url).hostname
  } catch {
    return false
  }
  return hosts.some(suffix => hostname === suffix || hostname.endsWith(`.${suffix}`))
}

/**
 * Merge expanded headers over the headers one call already carries.
 * @param input - first `fetch` argument.
 * @param init - second `fetch` argument.
 * @param headers - expanded header name/value pairs.
 * @returns a `RequestInit` carrying the merged headers.
 */
function withHeaders(input, init, headers) {
  const inherited = init?.headers ?? (input instanceof Request ? input.headers : undefined)
  const merged = new Headers(inherited ?? undefined)
  for (const [name, value] of Object.entries(headers)) merged.set(name, value)
  return { ...init, headers: merged }
}

/**
 * Install the scoped `fetch` wrapper.
 * @returns a disposer restoring the previous `fetch` when this plugin's wrapper is still the current one.
 */
function installFetchWrapper() {
  const original = globalThis.fetch
  const wrapped = function fetch(input, init) {
    const call = callScope.getStore()
    if (call === undefined || !hostMatches(input, call.hosts)) return original.call(this, input, init)
    return original.call(this, input, withHeaders(input, init, call.headers))
  }
  globalThis.fetch = wrapped
  return () => {
    // Another plugin may have wrapped `fetch` after this one; restoring then
    // would drop that plugin's wrapper, so only a still-current wrapper is undone.
    if (globalThis.fetch === wrapped) globalThis.fetch = original
  }
}

/**
 * Read the headers one route configured with the session placeholder, expanded
 * for one call.
 * @param settings - the settings service.
 * @param provider - the call's registered provider route.
 * @param sessionId - the call's session id.
 * @returns expanded header pairs, or undefined when the route configured none.
 */
function expandRouteHeaders(settings, provider, sessionId) {
  const config = settings.get(NS)
  if (config === null || typeof config !== 'object') return undefined
  const profile = config.providers?.[provider]
  if (profile === null || typeof profile !== 'object') return undefined
  const configured = profile.headers
  if (configured === null || typeof configured !== 'object') return undefined
  const expanded = {}
  for (const [name, value] of Object.entries(configured)) {
    if (typeof value !== 'string' || !value.includes(PLACEHOLDER)) continue
    if (RESERVED.has(name.toLowerCase())) continue
    expanded[name] = value.split(PLACEHOLDER).join(sessionId)
  }
  return Object.keys(expanded).length === 0 ? undefined : expanded
}

/**
 * Wrap one stream so its own iteration stays inside the call's scope.
 * @param create - builds the inner stream; runs inside the scope.
 * @param call - the scope payload.
 * @returns the stream proxied through the scope.
 */
function scopeStream(create, call) {
  const iterator = callScope.run(call, () => create()[Symbol.asyncIterator]())
  return {
    [Symbol.asyncIterator]() {
      return this
    },
    next() {
      return callScope.run(call, () => iterator.next())
    },
    return() {
      if (typeof iterator.return !== 'function') return Promise.resolve({ done: true, value: undefined })
      return callScope.run(call, () => iterator.return())
    },
    throw(error) {
      if (typeof iterator.throw !== 'function') return Promise.reject(error)
      return callScope.run(call, () => iterator.throw(error))
    },
  }
}

/** Plugin name shown by the Loader. */
export const name = 'dsh-provider-headers'

/** The host half reads provider profiles, so it waits for the settings service. */
export const inject = ['settings']

/**
 * Install the scope-aware `fetch` wrapper and the `llm/stream` listener that
 * fills the scope.
 * @param ctx - the plugin's Cordis context.
 * @param config - this entry's configuration, passed by the Loader.
 */
export function apply(ctx, config) {
  const dynamic = config?.dynamic !== false
  if (!dynamic) return
  const hosts = Array.isArray(config?.hosts) ? config.hosts.filter(host => typeof host === 'string') : []

  ctx.inject(['settings'], settingsCtx => {
    const settings = settingsCtx.settings
    ctx.effect(installFetchWrapper, 'dsh-provider-headers: scoped fetch wrapper')
    // `global: true` because this plugin is not a descendant of the llm
    // plugin's context, and `prepend` so the scope also covers any listener
    // registered after this one.
    ctx.on('llm/stream', (options, next) => {
      const headers = options.sessionId === undefined
        ? undefined
        : safeExpand(settings, options.provider, String(options.sessionId))
      if (headers === undefined) return next()
      return scopeStream(next, { headers, hosts })
    }, { global: true, prepend: true })
  })
}

/**
 * Expand one route's headers without letting a malformed configuration reach
 * the streaming call: a throw here would fail a model request.
 * @param settings - the settings service.
 * @param provider - the call's registered provider route.
 * @param sessionId - the call's session id.
 * @returns expanded header pairs, or undefined when nothing applies.
 */
function safeExpand(settings, provider, sessionId) {
  try {
    return expandRouteHeaders(settings, provider, sessionId)
  } catch {
    // The only statements here read a validated settings value; a throw means
    // that value is not the object the path assumes, and sending nothing is
    // the correct degradation for a header the Harness does not require.
    return undefined
  }
}
