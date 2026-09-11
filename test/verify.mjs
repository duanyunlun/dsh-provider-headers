/**
 * Behaviour check for the host half: a configured `${sessionId}` header must
 * reach the wire for the calling conversation, and nothing else may change.
 *
 * Run with `node test/verify.mjs`.
 */
import assert from 'node:assert/strict'
import { apply } from '../index.js'

/** Requests the wrapper let through, in order. */
const sent = []

/** Stand-in for the platform `fetch`; records instead of opening a socket. */
const recorder = async (input, init) => {
  sent.push({ url: String(input), headers: new Headers(init?.headers) })
  return { ok: true }
}

globalThis.fetch = recorder

/**
 * Build the slice of Cordis context `apply` uses.
 * @param config - plugin config as the Loader would pass it.
 * @param section - the resolved `llm-pi-ai` settings section.
 * @returns the context plus the listeners it registered.
 */
function makeContext(config, section) {
  const listeners = []
  const disposers = []
  return {
    listeners,
    disposers,
    ctx: {
      config,
      inject(names, callback) {
        callback({ settings: { get: namespace => (namespace === 'llm-pi-ai' ? section : undefined) } })
      },
      effect(callback) {
        disposers.push(callback())
      },
      on(name, listener, options) {
        listeners.push({ name, listener, options })
      },
    },
  }
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
  const { ctx, listeners } = makeContext({}, section)
  apply(ctx)
  const chunks = await streamOnce(listeners, { provider: 'opencode-go', model: 'm', sessionId: 'session-abc' })
  assert.deepEqual(chunks, [{ type: 'text', text: 'hi' }], 'chunks pass through unchanged')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].headers.get('x-opencode-session'), 'session-abc')
  assert.equal(sent[0].headers.get('authorization'), 'Bearer key', 'caller headers survive')
  assert.equal(sent[0].headers.get('user-agent'), null, 'Harness-owned name is never attached')
  assert.equal(sent[0].headers.get('x-static'), null, 'constant headers stay on the Harness path')
}

// 2. Two conversations on one route carry their own ids.
{
  sent.length = 0
  const { ctx, listeners } = makeContext({}, section)
  apply(ctx)
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
  const { ctx, listeners } = makeContext({}, section)
  apply(ctx)
  await streamOnce(listeners, { provider: 'plain', model: 'm', sessionId: 'session-abc' })
  assert.equal(sent[0].headers.get('x-static'), null)
  assert.equal(sent[0].headers.get('x-opencode-session'), null)
}

// 4. A call with no session id, and any call outside the scope, is untouched.
{
  sent.length = 0
  const { ctx, listeners } = makeContext({}, section)
  apply(ctx)
  await streamOnce(listeners, { provider: 'opencode-go', model: 'm' })
  assert.equal(sent[0].headers.get('x-opencode-session'), null)
  await globalThis.fetch('https://example.test/unrelated')
  assert.equal(sent[1].headers.get('x-opencode-session'), null, 'an unscoped fetch is untouched')
}

// 5. The host allowlist narrows the wrapper when configured.
{
  sent.length = 0
  const { ctx, listeners } = makeContext({ hosts: ['opencode.ai'] }, section)
  apply(ctx)
  await streamOnce(listeners, { provider: 'opencode-go', model: 'm', sessionId: 'session-abc' })
  assert.equal(sent[0].headers.get('x-opencode-session'), 'session-abc')
}

// 6. `dynamic: false` installs nothing at all.
{
  sent.length = 0
  const { ctx, listeners } = makeContext({ dynamic: false }, section)
  apply(ctx)
  assert.equal(listeners.length, 0, 'no listener registered')
  await globalThis.fetch('https://opencode.ai/v1/chat/completions')
  assert.equal(sent[0].headers.get('x-opencode-session'), null)
}

// 7. Disposal restores the `fetch` this plugin replaced, whatever it was.
{
  const before = globalThis.fetch
  const { ctx, disposers } = makeContext({}, section)
  apply(ctx)
  assert.notEqual(globalThis.fetch, before, 'the wrapper is installed')
  for (const dispose of disposers) dispose()
  assert.equal(globalThis.fetch, before, 'disposal restores the previous fetch')
  assert.equal(typeof disposers[0], 'function', 'apply publishes one disposer')
}

// 7b. A later wrapper from elsewhere is never clobbered by this one's disposal.
{
  const { ctx, disposers } = makeContext({}, section)
  apply(ctx)
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
  const { ctx, listeners } = makeContext({}, { providers: { 'opencode-go': { headers: 'not-an-object' } } })
  apply(ctx)
  await streamOnce(listeners, { provider: 'opencode-go', model: 'm', sessionId: 'session-abc' })
  assert.equal(sent[0].headers.get('x-opencode-session'), null)
}

console.log('dsh-provider-headers: 8 host-half checks passed')
