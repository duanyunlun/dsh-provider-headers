/**
 * Load the host half through real Cordis and assert the fiber reaches ACTIVE.
 *
 * This is the only check that exercises Cordis's context proxy: reading a
 * property the plugin never declared throws at load, which fails the whole
 * plugin tree. A permissive stand-in cannot see that class of defect, so the
 * harness also loads a deliberately broken twin and requires IT to fail —
 * otherwise a green result here would mean nothing.
 *
 * Needs `@deepseek-ai/cordis`, so it is a separate script from the
 * dependency-free `npm test`.
 *
 * Run with `npm run test:load`.
 */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../index.js'

/** Cordis fiber states this check distinguishes. */
const ACTIVE = 2
const FAILED = 3

/**
 * Load one plugin into a fresh context that provides the services it injects.
 * @param loaded - the plugin module to load.
 * @param config - the entry configuration.
 * @returns the fiber's state and the event names it registered.
 */
async function load(loaded, config) {
  const ctx = new Context()
  ctx.reflect.provide('settings', {
    get: namespace => (namespace === 'llm-pi-ai'
      ? { providers: { 'opencode-go': { headers: { 'x-opencode-session': '${sessionId}' } } } }
      : undefined),
  })

  const registered = []
  const events = ctx.events
  const originalOn = events.on.bind(events)
  events.on = (name, ...rest) => {
    registered.push(name)
    return originalOn(name, ...rest)
  }

  // Cordis reports a failed apply through the fiber's state, not by throwing
  // here; keep the check quiet while it runs.
  const originalError = console.error
  console.error = () => {}
  try {
    const fiber = ctx.plugin(loaded, config)
    await new Promise(resolve => setTimeout(resolve, 100))
    return { state: fiber.state, registered }
  } finally {
    console.error = originalError
  }
}

// 1. The shipped host half must activate and register its listener.
{
  const result = await load(plugin, {})
  assert.equal(result.state, ACTIVE, 'the plugin activates')
  assert.ok(result.registered.includes('llm/stream'), 'the waterfall listener is registered')
}

// 2. The same load with no config at all, which is what a patch row without a
//    `config:` key produces.
{
  const result = await load(plugin, undefined)
  assert.equal(result.state, ACTIVE, 'an absent config still activates')
}

// 3. `dynamic: false` must skip installation without failing.
{
  const result = await load(plugin, { dynamic: false })
  assert.equal(result.state, ACTIVE, 'the opt-out activates')
  assert.deepEqual(result.registered, [], 'the opt-out registers nothing')
}

// 4. Control: the defect that shipped in 0.1.0 must still fail here, or this
//    harness would pass a plugin that breaks the tree.
{
  const broken = {
    name: 'control-undeclared-property',
    inject: [],
    apply(ctx) {
      return ctx.config?.dynamic
    },
  }
  const result = await load(broken, {})
  assert.equal(result.state, FAILED, 'reading an undeclared property fails the fiber')
}

console.log('dsh-provider-headers: 4 real-Cordis load checks passed')
