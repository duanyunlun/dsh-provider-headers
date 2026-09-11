# dsh-provider-headers

English | [中文](README.md)

A per-provider **request-header editor** for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) Models settings page, with per-conversation `${sessionId}` expansion.

**No Harness source is modified, and no packaged application is patched.** The editor contributes through the seat the Models page declares for out-of-repository plugins, writes the field the Harness already reads, and disappears completely on uninstall.

## What it fixes

dsh already supports per-route request headers: `llm-pi-ai.providers.<route>.headers`. The Harness merges that field into

- the route's **model requests** (`packages/llm/llm-pi-ai/src/adapter.ts`), and
- the route's **"fetch available models"** request (`packages/llm/llm-pi-ai/src/discovery.ts`).

It has no Models-page editor — the package README says so, and the page tells you to edit `settings.yaml` by hand. This plugin adds that editor, plus the one thing static configuration cannot express: **a value that differs per conversation**.

## Install

Requires Node.js `^22.19.0 || >=24.0.0` and pnpm.

```sh
# once published to npm
dsh plugin --profile desktop add dsh-provider-headers

# from a local checkout
dsh plugin --profile desktop add /path/to/dsh-provider-headers

# or pack first
npm pack
dsh plugin --profile desktop add ./dsh-provider-headers-0.1.0.tgz
```

Substitute your profile name (`dsh` defaults to `web`). **Restart the profile** afterwards so the page loads the browser half.

The package declares `dsh.bundle.patch`, so it joins the profile's `dsh.profile.bundles` layer stack as a **bundle plugin** — no hand-written mount row, and Settings can enable, disable, and uninstall it directly.

```sh
dsh plugin --profile desktop remove dsh-provider-headers
```

Headers already written to `settings.yaml` are left in place.

## Getting into the plugin marketplace

An npm release alone does not put this package in the Settings marketplace. That index is maintained by the third-party [DSH-Plugins-Marketplace](https://github.com/bradeGithub/DSH-Plugins-Marketplace), which indexes every GitHub repository carrying the **`dsh-plugin`** topic (about 3,100 entries):

1. Push this repository to GitHub.
2. Give it the `dsh-plugin` topic, plus `deepseek-harness-plugin` and `request-headers` for search ranking.
3. Declare `repository` / `homepage` / `bugs` — the installer matches an installed plugin to an entry by package name and repository, in both directions.

The index refreshes on a delay, so a new repository does not appear immediately. The installer prefers npm when the package is published there.

## Use

1. Open **Settings → Models**.
2. Open any pi-ai provider card — shipped, built-in third-party, or hand-declared.
3. A **"Request headers (N)"** fold appears; add `Name` / `Value` rows and save.

### OpenCode Go

OpenCode requires `x-opencode-session` on every inference request from 09/05, carrying a **stable per-conversation id**. Add one row to the `opencode-go` card:

| Name | Value |
|---|---|
| `x-opencode-session` | `${sessionId}` |

Each conversation then sends its own id. A constant value works too and needs nothing from this plugin's host half.

## How `${sessionId}` works

The Harness cannot expand it: a provider profile is resolved once per route, so every conversation on the route shares one object.

The host half therefore scopes each streaming call to its own session with `AsyncLocalStorage` in an `llm/stream` waterfall listener, and wraps `globalThis.fetch` for the plugin's lifetime. Only requests made inside that scope receive the expanded headers; everything else reaches the original `fetch` untouched, and a wrapper another plugin installs later survives this one's disposal.

Only headers whose configured value contains the placeholder take this path.

## Configuration

```yaml
- id: model-headers
  config:
    dynamic: true      # default; false installs neither the wrapper nor the listener
    hosts: []          # default: any host inside a scoped call; set to narrow by suffix
```

## Known limitations

- **pi-ai routes only.** `llm-deepseek`'s `Config` has no `headers` field at all — its request headers are hardcoded — so DeepSeek's own card shows no editor and would need a Harness change.
- **`user-agent` cannot be replaced.** It is Harness-owned; both the native path and this plugin skip it.
- **`${sessionId}` covers streaming model requests only.** "Fetch available models" is a one-shot request the UI triggers directly; it never enters `llm/stream`, so it sends the literal text. Constant values are unaffected.
- **The editor renders inside the card, outside the "Edit" form**, because that is the only seat the Models page exposes.
- **Header values are stored as plain text** in `settings.yaml` and are not redacted. Keep credentials in `apiKeyEnv`.

## Development

```sh
npm test              # two checks, no dependencies, no dsh runtime
npm run test:load     # real-Cordis load check (needs @deepseek-ai/cordis)
```

- `test/verify.mjs` — host half: a fake context plus a recording `fetch`, asserting the expansion reaches the wire, concurrent conversations keep separate ids, reserved names are never attached, unscoped requests are untouched, and disposal restores `fetch`. The context stand-in is a strict proxy: reading an undeclared property throws, the way Cordis's own proxy does.
- `test/verify-client.mjs` — browser half: loads `client.js` the way the page's module queue does, drives the component through a minimal React stub, and asserts the registered seat and key plus the exact path operation written to `providers.<route>.headers`, fenced on revision.
- `test/load.mjs` — loads the host half into **real Cordis** and asserts the fiber reaches ACTIVE. It also loads a deliberately broken twin and requires that one to fail — without which a green result would mean nothing.

### Two defects already shipped, and why the checks now catch them

**Configuration has an argument, not a property.** 0.1.0 read `ctx.config`, but Cordis passes configuration as **`apply`'s second argument**. Reading the undeclared property throws inside `apply`, which fails the entire plugin tree — DSH is fail-loud by design. Only `test/load.mjs` (real Cordis) sees that class of defect.

**A dotted inject entry is not the service.** 0.1.1 declared `inject: ['slots', 'remote.settings', 'locale']` while reading `ctx.remote.settings`. Declaring `remote.settings` waits for that namespace; it does **not** permit reading `ctx.remote`. The plugin activated, then every read threw `cannot get property "remote" without inject` and the editor rendered as one error line.

That second defect survived because the check **hand-wrote** its allowlist and that list happened to contain `remote`. Both browser-half checks now **derive** the allowlist from the plugin's own exported `inject` — root segments only, plus the core methods verified present on a Cordis `Context` — so a hand-written list can no longer hide a mismatch between what the plugin declares and what it reads.

## License

MIT
