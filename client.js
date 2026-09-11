/**
 * `dsh-provider-headers` browser half.
 *
 * Contributes one editor to every pi-ai provider card on the Models settings
 * page through the seat that page declares for plugins distributed outside the
 * Harness repository: `settings.models.provider-card`, keyed by the card's
 * owning settings namespace.
 *
 * The editor writes the Harness's own
 * `llm-pi-ai.providers.<route>.headers` field. Nothing here teaches the Harness
 * what a header means: the pi-ai adapter already sends that field on the
 * route's model requests and on its model-list request, and already refuses
 * names the Harness owns.
 *
 * Values may contain `${sessionId}`, which the host half of this package
 * expands to the calling conversation's id. The Harness cannot expand it: a
 * provider profile is resolved once per route, so every conversation on the
 * route shares one value.
 *
 * This file is the loader's closure-factory artifact by hand, so the package
 * needs no build step: it registers a factory on the page's module queue and
 * resolves React through the module table the shell seeds.
 */
window.__ModuleLoader__.load({
	id: 'dsh-provider-headers',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports

		const React = require('react')
		const h = React.createElement

		/** Settings namespace owning pi-ai provider profiles. */
		const NS = 'llm-pi-ai'
		/** Placeholder the host half expands to the current conversation id. */
		const PLACEHOLDER = '${sessionId}'
		/** Locale namespace owning this package's copy. */
		const COPY_NS = 'dsh.modelHeaders'

		const en = {
			hint: 'Sent with this provider’s model requests and with “fetch available models”.',
			sessionHint: `In a value, ${PLACEHOLDER} becomes the current conversation id.`,
			reservedHint: 'user-agent is sent by the Harness and cannot be replaced here.',
			empty: 'No custom request headers.',
			summary: count => `Request headers (${count})`,
			nameLabel: 'Header name',
			valueLabel: 'Value',
			add: 'Add request header',
			remove: 'Remove this request header',
			save: 'Save',
			saving: 'Saving…',
			reset: 'Reset',
			saved: 'Saved.',
			unchanged: 'Nothing to save.',
			conflict: 'The settings document changed elsewhere; reopen this page and retry.',
			invalidName: name => `“${name}” is not a valid header name.`,
			duplicate: name => `“${name}” is listed twice.`,
			unavailable: 'Request headers are unavailable: the settings document is read-only or carries no llm-pi-ai section.',
		}

		const zh = {
			hint: '随该提供方的模型请求和「获取可用模型」请求一起发送。',
			sessionHint: `值中的 ${PLACEHOLDER} 会替换为当前会话 ID。`,
			reservedHint: 'user-agent 由 Harness 发送，此处无法替换。',
			empty: '暂无自定义请求头。',
			summary: count => `自定义请求头（${count}）`,
			nameLabel: '请求头名称',
			valueLabel: '值',
			add: '添加请求头',
			remove: '删除该请求头',
			save: '保存',
			saving: '保存中…',
			reset: '重置',
			saved: '已保存。',
			unchanged: '没有需要保存的改动。',
			conflict: '设置文档已在别处改动，请重新打开本页后重试。',
			invalidName: name => `「${name}」不是合法的请求头名称。`,
			duplicate: name => `「${name}」重复出现。`,
			unavailable: '自定义请求头不可用：设置文档为只读，或没有 llm-pi-ai 段。',
		}

		/**
		 * Read one path out of a stored settings subtree.
		 * @param value - the subtree root.
		 * @param path - segment names.
		 * @returns the value at the path, or undefined.
		 */
		function getPath(value, path) {
			let current = value
			for (const segment of path) {
				if (current === null || typeof current !== 'object') return undefined
				current = current[segment]
			}
			return current
		}

		/**
		 * Project a stored headers object into editor rows.
		 * @param stored - the stored `headers` value.
		 * @returns the editor rows, in stored order.
		 */
		function toRows(stored) {
			if (stored === null || typeof stored !== 'object') return []
			const taken = new Set()
			return Object.entries(stored).map(([name, value]) => {
				let key = name
				for (let n = 2; taken.has(key); n += 1) key = `${name}#${n}`
				taken.add(key)
				return { key, name, value: typeof value === 'string' ? value : String(value) }
			})
		}

		/**
		 * Project editor rows back into the stored headers object.
		 * @param rows - the editor rows.
		 * @returns the headers to store, dropping rows with a blank name.
		 */
		function toHeaders(rows) {
			const stored = {}
			for (const row of rows) {
				const name = row.name.trim()
				if (name !== '') stored[name] = row.value
			}
			return stored
		}

		/**
		 * Whether two header objects carry the same names and values.
		 * @param left - one headers object.
		 * @param right - the other headers object.
		 * @returns true when nothing would change on save.
		 */
		function sameHeaders(left, right) {
			const names = Object.keys(left)
			if (names.length !== Object.keys(right).length) return false
			return names.every(name => right[name] === left[name])
		}

		/**
		 * The first problem that makes these rows unsendable.
		 * @param rows - the editor rows.
		 * @param t - copy lookup.
		 * @returns the message, or undefined when every row can be sent.
		 */
		function validate(rows, t) {
			const seen = new Set()
			for (const row of rows) {
				const name = row.name.trim()
				if (name === '') continue
				try {
					new Headers([[name, row.value]])
				} catch {
					return t('invalidName')(name)
				}
				const lower = name.toLowerCase()
				if (seen.has(lower)) return t('duplicate')(name)
				seen.add(lower)
			}
			return undefined
		}

		const styles = {
			block: {
				margin: '10px 0 0',
				padding: '10px 12px',
				border: '1px solid var(--dsw-alias-border-l2)',
				borderRadius: '10px',
				background: 'var(--dsw-alias-bg-layer-1)',
				color: 'var(--dsw-alias-label-primary)',
				fontSize: '13px',
			},
			summary: {
				cursor: 'pointer',
				color: 'var(--dsw-alias-label-secondary)',
				userSelect: 'none',
			},
			hint: {
				margin: '8px 0 10px',
				color: 'var(--dsw-alias-label-tertiary)',
				lineHeight: 1.5,
			},
			row: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '6px' },
			input: {
				flex: 1,
				minWidth: 0,
				padding: '6px 8px',
				border: '1px solid var(--dsw-alias-border-l2)',
				borderRadius: '6px',
				background: 'transparent',
				color: 'inherit',
				font: 'inherit',
			},
			iconButton: {
				flex: '0 0 auto',
				padding: '6px 8px',
				border: '1px solid var(--dsw-alias-border-l2)',
				borderRadius: '6px',
				background: 'transparent',
				color: 'var(--dsw-alias-label-secondary)',
				cursor: 'pointer',
				font: 'inherit',
			},
			add: {
				marginTop: '2px',
				padding: '6px 10px',
				border: '1px dashed var(--dsw-alias-border-l3)',
				borderRadius: '6px',
				background: 'transparent',
				color: 'var(--dsw-alias-label-secondary)',
				cursor: 'pointer',
				font: 'inherit',
			},
			footer: {
				display: 'flex',
				gap: '8px',
				alignItems: 'center',
				justifyContent: 'flex-end',
				marginTop: '10px',
			},
			primary: {
				padding: '6px 14px',
				border: 'none',
				borderRadius: '6px',
				background: 'var(--dsw-alias-button-primary-fill)',
				color: 'var(--dsw-alias-label-primary-foreground)',
				cursor: 'pointer',
				font: 'inherit',
			},
			secondary: {
				padding: '6px 12px',
				border: '1px solid var(--dsw-alias-border-l2)',
				borderRadius: '6px',
				background: 'transparent',
				color: 'var(--dsw-alias-label-secondary)',
				cursor: 'pointer',
				font: 'inherit',
			},
			status: { flex: 1, color: 'var(--dsw-alias-label-tertiary)' },
			error: { flex: 1, color: 'var(--dsw-alias-state-error-primary)' },
		}

		/**
		 * One provider card's request-header editor.
		 * @param props - the slot's owner share plus this plugin's inject face.
		 * @returns the editor element.
		 */
		function HeadersCard(props) {
			const t = props.t
			const path = Array.isArray(props.provider.settingsPath) ? props.provider.settingsPath : []
			const pathKey = path.join('\u0000')
			const nextKey = React.useRef(0)
			const [rows, setRows] = React.useState(null)
			const [stored, setStored] = React.useState({})
			const [revision, setRevision] = React.useState(undefined)
			const [busy, setBusy] = React.useState(false)
			const [open, setOpen] = React.useState(false)
			const [notice, setNotice] = React.useState(undefined)
			const [problem, setProblem] = React.useState(undefined)
			const [unavailable, setUnavailable] = React.useState(undefined)

			const load = React.useCallback(async () => {
				const answer = await props.read()
				if (!answer.ok) {
					setRows([])
					setUnavailable(answer.message)
					return
				}
				const current = getPath(answer.view.user, [...path, 'headers'])
				const projected = toRows(current)
				setStored(current !== null && typeof current === 'object' ? { ...current } : {})
				setRows(projected)
				setRevision(answer.view.revision)
				setOpen(projected.length > 0)
				setUnavailable(undefined)
				setProblem(undefined)
				setNotice(undefined)
				// `pathKey` is the stable identity of this card's settings
				// address; the array itself is rebuilt on every render.
			}, [props.read, pathKey])

			React.useEffect(() => {
				void load()
			}, [load])

			const edit = (key, field, value) => {
				setRows(current => current.map(row => (row.key === key ? { ...row, [field]: value } : row)))
				setNotice(undefined)
				setProblem(undefined)
			}

			const save = async () => {
				const next = toHeaders(rows)
				const refused = validate(rows, t)
				if (refused !== undefined) {
					setProblem(refused)
					return
				}
				if (sameHeaders(next, stored)) {
					setProblem(undefined)
					setNotice(t('unchanged'))
					return
				}
				setBusy(true)
				setProblem(undefined)
				const ops = Object.keys(next).length === 0
					? [{ op: 'unset', path: [...path, 'headers'] }]
					: [{ op: 'set', path: [...path, 'headers'], value: next }]
				const answer = await props.write(ops, revision)
				setBusy(false)
				if (!answer.ok) {
					setProblem(answer.conflict ? t('conflict') : answer.message)
					return
				}
				const current = getPath(answer.view.user, [...path, 'headers'])
				setStored(current !== null && typeof current === 'object' ? { ...current } : {})
				setRows(toRows(current))
				setRevision(answer.view.revision)
				setNotice(t('saved'))
			}

			if (rows === null) return null

			if (unavailable !== undefined) {
				return h('div', { style: styles.block }, h('p', { style: styles.error, role: 'alert' }, unavailable))
			}

			const body = [
				h('p', { key: 'hint', style: styles.hint },
					`${t('hint')} ${t('sessionHint')} ${t('reservedHint')}`),
			]
			if (rows.length === 0) body.push(h('p', { key: 'empty', style: styles.hint }, t('empty')))
			for (const row of rows) {
				body.push(h('div', { key: row.key, style: styles.row }, [
					h('input', {
						key: 'name',
						style: styles.input,
						value: row.name,
						placeholder: t('nameLabel'),
						'aria-label': t('nameLabel'),
						spellCheck: false,
						onChange: event => edit(row.key, 'name', event.target.value),
					}),
					h('input', {
						key: 'value',
						style: styles.input,
						value: row.value,
						placeholder: t('valueLabel'),
						'aria-label': t('valueLabel'),
						spellCheck: false,
						onChange: event => edit(row.key, 'value', event.target.value),
					}),
					h('button', {
						key: 'remove',
						type: 'button',
						style: styles.iconButton,
						'aria-label': t('remove'),
						title: t('remove'),
						onClick: () => {
							setRows(current => current.filter(candidate => candidate.key !== row.key))
							setNotice(undefined)
						},
					}, '✕'),
				]))
			}
			body.push(h('button', {
				key: 'add',
				type: 'button',
				style: styles.add,
				onClick: () => {
					nextKey.current += 1
					const key = `added-${nextKey.current}`
					setRows(current => [...current, { key, name: '', value: '' }])
					setNotice(undefined)
				},
			}, `＋ ${t('add')}`))
			body.push(h('div', { key: 'footer', style: styles.footer }, [
				h('span', {
					key: 'status',
					style: problem === undefined ? styles.status : styles.error,
					role: problem === undefined ? undefined : 'alert',
				}, problem ?? notice ?? ''),
				h('button', {
					key: 'reset',
					type: 'button',
					style: styles.secondary,
					disabled: busy,
					onClick: () => { void load() },
				}, t('reset')),
				h('button', {
					key: 'save',
					type: 'button',
					style: styles.primary,
					disabled: busy,
					onClick: () => { void save() },
				}, busy ? t('saving') : t('save')),
			]))

			return h('details', { style: styles.block, open }, [
				h('summary', {
					key: 'summary',
					style: styles.summary,
					onClick: event => {
						// Controlled `open`: React owns the attribute, so the
						// click is turned into state instead of the DOM's own
						// toggle, which React would immediately revert.
						event.preventDefault()
						setOpen(current => !current)
					},
				}, t('summary')(rows.length)),
				...body,
			])
		}

		/** Services this plugin's browser half reads. */
		const inject = ['slots', 'remote.settings', 'locale']

		/**
		 * Register the locale dictionaries and the provider-card editor.
		 * @param ctx - the browser plugin's Cordis context.
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(COPY_NS, { zh, en }), 'dsh-provider-headers: copy dictionaries')
			const t = ctx.locale.bind(COPY_NS)

			// Built once: the renderer calls `inject` on every render, and a
			// fresh object per call would restart the editor's load effect.
			const api = {
				t,
				read: async () => {
					const response = await ctx.remote.settings.describe()
					if (!response.ok) return { ok: false, message: response.error.message }
					const view = response.value.namespaces.find(candidate => candidate.ns === NS)
					if (view === undefined) return { ok: false, message: t('unavailable') }
					return { ok: true, view }
				},
				write: async (ops, revision) => {
					const response = await ctx.remote.settings.mutate(NS, ops, revision)
					if (response.ok) return { ok: true, view: response.value }
					return {
						ok: false,
						conflict: response.error.code === 'settings/conflict',
						message: response.error.message,
					}
				},
			}

			ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
				name: 'settings.models.provider-card',
				key: NS,
				locale: COPY_NS,
				inject: () => api,
			}, HeadersCard))
		}

		exports.apply = apply
		exports.inject = inject
		return module.exports
	},
})
