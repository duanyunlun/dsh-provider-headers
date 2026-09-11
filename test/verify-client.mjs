/**
 * Behaviour check for the browser half: the bundle must load through the
 * page's module queue, register into the Models page seat with the pi-ai
 * namespace as its key, and write the configured headers to the provider's own
 * settings path.
 *
 * Run with `node test/verify-client.mjs`.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/** The mount whose hooks the React stub dispatches into. */
let active = null

/** Element factory shared by the stub and every assertion below. */
function createElement(type, props, ...children) {
  return { type, props: props ?? {}, children: children.flat(Infinity).filter(child => child != null) }
}

/** Hook surface of the stub; delegates to the mount currently rendering. */
const React = {
  createElement,
  useState: (...args) => active.useState(...args),
  useRef: (...args) => active.useRef(...args),
  useCallback: (...args) => active.useCallback(...args),
  useEffect: (...args) => active.useEffect(...args),
}

/**
 * Mount one function component against hook state that survives re-renders.
 * @param component - the function component to render.
 * @param props - the props every render receives.
 * @returns the mount, with its current tree and a re-render entry point.
 */
function mount(component, props) {
  const slots = []
  const pending = []
  let cursor = 0
  let queued = false
  const self = {
    tree: undefined,
    render,
    text: () => flattenText(self.tree).join(' '),
    find: predicate => find(self.tree, predicate),
    findAll: predicate => findAll(self.tree, predicate),
    useState(initial) {
      const index = cursor++
      slots[index] ??= { value: typeof initial === 'function' ? initial() : initial }
      const slot = slots[index]
      return [slot.value, next => {
        slot.value = typeof next === 'function' ? next(slot.value) : next
        schedule()
      }]
    },
    useRef(initial) {
      const index = cursor++
      slots[index] ??= { current: initial }
      return slots[index]
    },
    useCallback(fn, deps) {
      const index = cursor++
      if (slots[index] === undefined || !sameDeps(slots[index].deps, deps)) slots[index] = { fn, deps }
      return slots[index].fn
    },
    useEffect(fn, deps) {
      const index = cursor++
      if (slots[index] === undefined || !sameDeps(slots[index].deps, deps)) {
        slots[index] = { deps }
        pending.push(fn)
      }
    },
  }
  function schedule() {
    if (queued) return
    queued = true
    queueMicrotask(() => {
      queued = false
      render()
    })
  }
  function render() {
    const previous = active
    active = self
    cursor = 0
    try {
      self.tree = component(props)
    } finally {
      active = previous
    }
    while (pending.length > 0) pending.shift()()
  }
  render()
  return self
}

/**
 * Whether two dependency lists are the same to the depth this stub compares.
 * @param left - previous dependencies.
 * @param right - next dependencies.
 * @returns true when the effect or callback may be reused.
 */
function sameDeps(left, right) {
  return left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
}

/**
 * Walk a tree and return the first element matching a predicate.
 * @param node - the tree or element to walk.
 * @param predicate - the match.
 * @returns the element, or undefined.
 */
function find(node, predicate) {
  if (node == null || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, predicate)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  if (predicate(node)) return node
  for (const child of node.children ?? []) {
    const hit = find(child, predicate)
    if (hit !== undefined) return hit
  }
  return undefined
}

/**
 * Walk a tree and return every element matching a predicate.
 * @param node - the tree or element to walk.
 * @param predicate - the match.
 * @returns the matching elements.
 */
function findAll(node, predicate) {
  const hits = []
  const walk = candidate => {
    if (candidate == null || typeof candidate !== 'object') return
    if (Array.isArray(candidate)) {
      for (const child of candidate) walk(child)
      return
    }
    if (predicate(candidate)) hits.push(candidate)
    for (const child of candidate.children ?? []) walk(child)
  }
  walk(node)
  return hits
}

/**
 * Collect the text content of a tree.
 * @param node - the tree or element to read.
 * @returns the text fragments in order.
 */
function flattenText(node) {
  if (node == null) return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap(flattenText)
  if (typeof node !== 'object') return []
  return (node.children ?? []).flatMap(flattenText)
}

/** Let queued microtasks and the component's promises settle. */
async function flush() {
  for (let tick = 0; tick < 6; tick += 1) await new Promise(resolve => setTimeout(resolve, 0))
}

/**
 * Load the browser bundle the way the page's module queue does.
 * @returns the module namespace the factory returned.
 */
function loadBundle() {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const registered = []
  globalThis.window = { __ModuleLoader__: { load: registration => registered.push(registration) } }
  // eslint-disable-next-line no-new-func -- the bundle is browser-format code
  new Function('window', source)(globalThis.window)
  assert.equal(registered.length, 1, 'the bundle announces exactly one registration')
  assert.equal(registered[0].id, 'dsh-provider-headers', 'the registration carries the package name as its id')
  return registered[0].factory(specifier => {
    if (specifier === 'react') return React
    throw new Error(`unexpected module request: ${specifier}`)
  })
}

// ---------------------------------------------------------------------------

const loaded = loadBundle()
assert.deepEqual(loaded.inject, ['slots', 'remote.settings', 'locale'], 'the browser half declares its services')

const dictionaries = {}
const translations = { zh: {}, en: {} }
const registrations = []
const calls = { describe: 0, mutate: [] }

/** The stored settings document the fake Host serves. */
const document = {
  writable: true,
  namespaces: [{
    ns: 'llm-pi-ai',
    revision: 7,
    user: { providers: { 'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY' } } },
  }],
}

/**
 * Apply remote path operations to a stored user section the way the Host does.
 * @param user - the namespace's stored user subtree, mutated in place.
 * @param ops - the path operations the editor sent.
 */
function applyOps(user, ops) {
  for (const op of ops) {
    const parents = op.path.slice(0, -1)
    const last = op.path[op.path.length - 1]
    let node = user
    for (const segment of parents) {
      node[segment] ??= {}
      node = node[segment]
    }
    if (op.op === 'unset') delete node[last]
    else node[last] = op.value
  }
}

const ctx = {
  effect(callback) {
    callback()
  },
  locale: {
    register(namespace, dicts) {
      dictionaries[namespace] = dicts
      for (const [id, dict] of Object.entries(dicts)) Object.assign(translations[id], dict)
      return () => {}
    },
    bind: () => {
      // Copy lookup only: this check renders English.
      return key => translations.en[key]
    },
  },
  slots: {
    inject(name, callback) {
      assert.equal(name, 'settings.models.provider-card', 'the browser half waits on the Models seat')
      callback()
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  },
  remote: {
    settings: {
      async describe() {
        calls.describe += 1
        return { ok: true, value: document }
      },
      async mutate(ns, ops, revision) {
        calls.mutate.push({ ns, ops, revision })
        applyOps(document.namespaces[0].user, ops)
        document.namespaces[0].revision = revision + 1
        return { ok: true, value: { ...document.namespaces[0] } }
      },
    },
  },
}

/** Services and core methods the browser half declares, and nothing else. */
const DECLARED = new Set(['effect', 'locale', 'slots', 'remote'])

/**
 * Apply the Cordis context rule to the stand-in: a property the plugin never
 * declared throws, so an undeclared read fails here instead of at boot.
 * @param target - the permissive stand-in.
 * @returns the same object behind the rule.
 */
function strict(target) {
  return new Proxy(target, {
    get(object, prop) {
      if (typeof prop === 'string' && !DECLARED.has(prop)) {
        throw new Error(`cannot get property "${prop}" without inject`)
      }
      return object[prop]
    },
  })
}

loaded.apply(strict(ctx))

assert.equal(registrations.length, 1, 'apply registers exactly one contribution')
assert.equal(registrations[0].options.name, 'settings.models.provider-card')
assert.equal(registrations[0].options.key, 'llm-pi-ai', 'the key is the pi-ai settings namespace')
assert.ok(dictionaries['dsh.modelHeaders'] !== undefined, 'the copy dictionary is registered')

const ownerProps = {
  provider: {
    provider: 'opencode-go',
    displayName: 'opencode-go',
    settingsNs: 'llm-pi-ai',
    settingsPath: ['providers', 'opencode-go'],
    active: true,
  },
  configured: true,
  keyConfigured: true,
}

const view = mount(registrations[0].component, { ...ownerProps, ...registrations[0].options.inject() })
await flush()

/** Re-query the live tree: a save replaces the rows, so held elements go stale. */
const fields = () => view.findAll(node => node.type === 'input')
/** Find the live button whose text is exactly this label. */
const button = label => view.find(node => node.type === 'button' && flattenText(node).join('') === label)

// 1. The editor loads the provider's stored headers through the Host.
assert.equal(calls.describe, 1, 'the editor reads the settings document once')
assert.match(view.text(), /Request headers \(0\)/, 'the fold reports the stored header count')

// 2. Adding a row and saving writes the provider's own path, fenced on revision.
button('＋ Add request header').props.onClick()
await flush()
let inputs = fields()
assert.equal(inputs.length, 2, 'one name field and one value field render per row')
inputs[0].props.onChange({ target: { value: 'x-opencode-session' } })
inputs[1].props.onChange({ target: { value: '${sessionId}' } })
await flush()
button('Save').props.onClick()
await flush()

assert.equal(calls.mutate.length, 1, 'saving writes once')
assert.equal(calls.mutate[0].ns, 'llm-pi-ai')
assert.equal(calls.mutate[0].revision, 7, 'the write is fenced on the revision the editor read')
assert.deepEqual(calls.mutate[0].ops, [{
  op: 'set',
  path: ['providers', 'opencode-go', 'headers'],
  value: { 'x-opencode-session': '${sessionId}' },
}], 'the write targets the provider profile the Harness already reads')
assert.match(view.text(), /Request headers \(1\)/, 'the fold follows the stored count')

// 3. An invalid header name is refused before any write leaves the page.
fields()[0].props.onChange({ target: { value: 'bad header name' } })
await flush()
button('Save').props.onClick()
await flush()
assert.equal(calls.mutate.length, 1, 'an invalid name performs no write')
assert.match(view.text(), /not a valid header name/, 'the refusal is shown')

// 4. Clearing every row removes the stored block rather than storing an empty object.
fields()[0].props.onChange({ target: { value: 'x-opencode-session' } })
await flush()
button('✕').props.onClick()
await flush()
button('Save').props.onClick()
await flush()
assert.deepEqual(calls.mutate[1].ops, [{ op: 'unset', path: ['providers', 'opencode-go', 'headers'] }],
  'emptying the editor unsets the block')

// 5. A missing namespace shows the unavailable message instead of throwing.
{
  const other = []
  const bare = {
    ...ctx,
    slots: {
      inject: (name, callback) => callback(),
      register: (options, component) => other.push({ options, component }),
    },
    remote: { settings: { describe: async () => ({ ok: true, value: { writable: true, namespaces: [] } }) } },
  }
  loadBundle().apply(strict(bare))
  assert.equal(other.length, 1)
  const empty = mount(other[0].component, { ...ownerProps, ...other[0].options.inject() })
  await flush()
  assert.match(empty.text(), /Request headers are unavailable/, 'a missing namespace degrades to a message')
}

// 6. The rule the stand-in enforces is the rule that broke 0.1.0: reading a
//    name the plugin never declared fails at boot.
{
  assert.throws(() => strict(ctx).config, /cannot get property "config" without inject/)
}

console.log('dsh-provider-headers: 6 browser-half checks passed')
