/**
 * Behaviour check for the host half: a configured `${sessionId}` header must
 * reach the wire for the calling conversation, and nothing else may change.
 *
 * The context stand-in is a strict proxy: reading a property the plugin did
 * not declare throws, the way Cordis's own context proxy does. A permissive
 * plain object would accept `ctx.config`, which the Loader never exposes —
 * configuration arrives as `apply`'s second argument.
 *
 * Run with `node test/verify.mjs`.
 */
import assert from 'node:assert/strict'
import { apply as applyPlugin } from '../index.js'

/** Requests the wrapper let through, in order. */
const sent = []

/** Stand-in for the platform `fetch`; records instead of opening a socket. */
const recorder = async (input, init) => {
  sent.push({ url: String(input), headers: new Headers(init?.headers) })
  return { ok: true }
}

globalThis.fetch = recorder

/**
 * Wrap a service store in the Cordis context proxy rule: a name reaches the
 * store only through `inject`, and anything else throws.
 * @param get - resolves one service name.
 * @param methods - the core context methods this slice of the plugin uses.
 * @returns the proxied context.
 */
function contextProxy(get, methods) {
  return new Proxy({}, {
    get(_target, prop) {
      if (typeof prop === 'string' && prop in methods) return methods[prop]
      const value = get(prop)
      if (value !== undefined) return value
      throw new Error(`cannot get property "${String(prop)}" without inject`)
    },
  })
}

/**
 * Build the slice of Cordis context `apply` uses.
 * @param config - the entry configuration the Loader would pass.
 * @param section - the resolved `llm-pi-ai` settings section.
 * @returns the context, its config, and the listeners it registered.
 */
function makeContext(config, section) {
  const listeners = []
  const disposers = []
  const services = {
    settings: { get: namespace => (namespace === 'llm-pi-ai' ? section : undefined) },
  }
  const ctx = contextProxy(name => services[name], {
    // `ctx.get` is a core Context method for optional lookups, and it returns
    // undefined for an unknown name rather than throwing — the plugin relies on
    // that when it probes for `clientModules`.
    get: name => services[name],
    inject(names, callback) {
      for (const name of names) {
        assert.ok(name in services, `inject("${name}") names a service the check provides`)
      }
      callback(contextProxy(name => services[name], { get: name => services[name] }))
    },
    effect(callback) {
      disposers.push(callback())
    },
    on(name, listener, options) {
      listeners.push({ name, listener, options })
    },
  })
  return { ctx, config, listeners, disposers }
}

/**
 * Drive one streaming call through the registered waterfall listener.
 * @param listeners - listeners `apply` registered.
 * @param options - the `GenerateOptions` the runtime would dispatch.
 * @returns every chunk the stream produced.
 */
async function streamOnce(listeners, options) {
  const entry = listeners.find(candidate => candidate.name === 'llm/stream')
  assert.ok(entry !== undefined, 'apply registered an llm/stream listener')
  async function* inner() {
    await globalThis.fetch('https://opencode.ai/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer key' },
    })
    yield { type: 'text', text: 'hi' }
  }
  const chunks = []
  for await (const chunk of entry.listener(options, () => inner())) chunks.push(chunk)
  return chunks
}

/**
 * Mount the plugin against one configuration and section.
 * @param config - the entry configuration.
 * @param section - the resolved `llm-pi-ai` settings section.
 * @returns the registered listeners and the effect disposers.
 */
function mount(config, section) {
  const built = makeContext(config, section)
  applyPlugin(built.ctx, built.config)
  return built
}

const section = {
  providers: {
    'opencode-go': {
      headers: {
        'x-opencode-session': '${sessionId}',
        'x-static': 'unchanged',
        'user-agent': 'must-not-ship',
      },
    },
    plain: { headers: { 'x-static': 'only' } },
  },
}

// 1. A configured placeholder reaches the wire, expanded, beside the caller's
//    own headers; the Harness-owned name is left alone.
{
  const { listeners } = mount({}, section)
  const chunks = await streamOnce(listeners, { provider: 'opencode-go', model: 'm', sessionId: 'session-abc' })
  assert.deepEqual(chunks, [{ type: 'text', text: 'hi' }], 'chunks pass through unchanged')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].headers.get('x-opencode-session'), 'session-abc')
  assert.equal(sent[0].headers.get('authorization'), 'Bearer key', 'caller headers survive')
  assert.equal(sent[0].headers.get('user-agent'), null, 'Harness-owned name is never attached')
  assert.equal(sent[0].headers.get('x-static'), null, 'constant headers stay on the Harness path')
}

// 1b. The Loader may hand a row no configuration at all.
{
  sent.length = 0
  const { listeners } = mount(undefined, section)
  await streamOnce(listeners, { provider: 'opencode-go', model: 'm', sessionId: 'session-abc' })
  assert.equal(sent[0].headers.get('x-opencode-session'), 'session-abc', 'an absent config still expands')
}

// 2. Two conversations on one route carry their own ids.
{
  sent.length = 0
  const { listeners } = mount({}, section)
  await Promise.all([
    streamOnce(listeners, { provider: 'opencode-go', model: 'm', sessionId: 'session-one' }),
    streamOnce(listeners, { provider: 'opencode-go', model: 'm', sessionId: 'session-two' }),
  ])
  const ids = sent.map(request => request.headers.get('x-opencode-session')).sort()
  assert.deepEqual(ids, ['session-one', 'session-two'], 'concurrent calls keep their own ids')
}

// 3. A route with no placeholder leaves the request byte-identical.
{
  sent.length = 0
  const { listeners } = mount({}, section)
  await streamOnce(listeners, { provider: 'plain', model: 'm', sessionId: 'session-abc' })
  assert.equal(sent[0].headers.get('x-static'), null)
  assert.equal(sent[0].headers.get('x-opencode-session'), null)
}

// 4. A call with no session id, and any call outside the scope, is untouched.
{
  sent.length = 0
  const { listeners } = mount({}, section)
  await streamOnce(listeners, { provider: 'opencode-go', model: 'm' })
  assert.equal(sent[0].headers.get('x-opencode-session'), null)
  await globalThis.fetch('https://example.test/unrelated')
  assert.equal(sent[1].headers.get('x-opencode-session'), null, 'an unscoped fetch is untouched')
}

// 5. The host allowlist narrows the wrapper when configured.
{
  sent.length = 0
  const { listeners } = mount({ hosts: ['opencode.ai'] }, section)
  await streamOnce(listeners, { provider: 'opencode-go', model: 'm', sessionId: 'session-abc' })
  assert.equal(sent[0].headers.get('x-opencode-session'), 'session-abc')
}

// 6. `dynamic: false` installs nothing at all.
{
  sent.length = 0
  const { listeners } = mount({ dynamic: false }, section)
  assert.equal(listeners.length, 0, 'no listener registered')
  await globalThis.fetch('https://opencode.ai/v1/chat/completions')
  assert.equal(sent[0].headers.get('x-opencode-session'), null)
}

// 7. Disposal restores the `fetch` this plugin replaced, whatever it was.
{
  const before = globalThis.fetch
  const { disposers } = mount({}, section)
  assert.notEqual(globalThis.fetch, before, 'the wrapper is installed')
  for (const dispose of disposers) dispose()
  assert.equal(globalThis.fetch, before, 'disposal restores the previous fetch')
  assert.equal(typeof disposers[0], 'function', 'apply publishes one disposer')
}

// 7b. A later wrapper from elsewhere is never clobbered by this one's disposal.
{
  const { disposers } = mount({}, section)
  const later = globalThis.fetch
  globalThis.fetch = recorder
  for (const dispose of disposers) dispose()
  assert.equal(globalThis.fetch, recorder, 'a foreign wrapper survives disposal')
  globalThis.fetch = later
  for (const dispose of disposers) dispose()
}

// 8. A malformed section degrades to sending nothing rather than failing a call.
{
  sent.length = 0
  const { listeners } = mount({}, { providers: { 'opencode-go': { headers: 'not-an-object' } } })
  await streamOnce(listeners, { provider: 'opencode-go', model: 'm', sessionId: 'session-abc' })
  assert.equal(sent[0].headers.get('x-opencode-session'), null)
}

// 9. Reading a service the plugin never declared fails, the way Cordis fails:
//    a stray `ctx.config` is exactly this, and it is what broke 0.1.0.
{
  const built = makeContext({}, section)
  assert.throws(() => built.ctx.config, /cannot get property "config" without inject/)
}

console.log('dsh-provider-headers: 10 host-half checks passed')
