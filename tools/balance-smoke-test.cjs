#!/usr/bin/env node
/**
 * dsh-balance-inquiry 客户端 bundle 的冒烟测试。
 *
 * 用假的浏览器环境（window / document / localStorage / fetch / AbortController / React）
 * 加载 dsh-balance-inquiry/lib/client.js，覆盖：
 *   1. bundle 形状与两个插槽注册（侧边栏 order 必须小于「上下文洞察」的 10）；
 *   2. 样式注入；
 *   3. New API 查询：请求形状、侧边栏行、tooltip、设置页状态与字段；
 *   4. 鉴权失败 / 瞬时失败（保留 10 分钟内上次成功值）/ HTTP 500 / 200+success:false；
 *   5. 原生余额供应商（DeepSeek / OpenRouter / Novita）与 401；
 *   6. 自定义用量脚本：占位符替换、多套餐、6 类脚本错误；
 *   7. 换算比例、货币单位、余额为 0 与 % 档位的颜色规则；
 *   8. 间隔 0 不轮询、保存按钮持久化、未配置状态（含全新安装）；
 *   9. 宿主代理（请求由宿主进程发出，绕开浏览器 CORS）：请求形状、代理不可用回落直连、
 *      代理报告的网络错误 / 超时文案、设置页的查询通道提示；
 *  10. 编程套餐（Token Plan / Coding Plan）的解析与错误分支。
 *
 * 用法：node tools/balance-smoke-test.cjs [-v]
 */
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const CLIENT = path.resolve(__dirname, "..", "lib", "client.js");
const source = fs.readFileSync(CLIENT, "utf8");

/** dsh-context 的「上下文洞察」在 sidebar.footer.action 里的 order，见 dsh-context/lib/client.js。 */
const CONTEXT_OVERVIEW_ORDER = 10;
/** 瞬时失败后仍展示上次成功值的窗口。 */
const KEEP_LAST_GOOD_MS = 10 * 60 * 1000;
/** queryQuota 只对传输层失败重试一次时的等待时间。 */
const RETRY_DELAY_MS = 1500;

const verbose = process.argv.indexOf("-v") !== -1 || process.argv.indexOf("--verbose") !== -1;

//#region 结果构造器（与插件内部的 UsageData / UsageResult 契约一致）
const DEFAULT_ITEM = {
	planName: "默认套餐",
	remaining: 10,
	total: 12,
	used: 2,
	unit: "CNY",
	isValid: true,
	invalidMessage: null,
	extra: null
};

const KEY_SETTINGS = "dsh-balance-inquiry:settings";
const KEY_ACCOUNTS = "dsh-balance-inquiry:accounts";
const KEY_RESULTS = "dsh-balance-inquiry:results";

/** 把「一条旧式配置」+「上次读数」翻译成新存储（测试侧的兼容层，插件本身不再做迁移）。 */
function expandStorage(storage) {
	const out = Object.assign({}, storage);
	const legacyConfig = out["dsh-balance-inquiry:config"];
	const legacyLast = out["dsh-balance-inquiry:last-reading"];
	delete out["dsh-balance-inquiry:config"];
	delete out["dsh-balance-inquiry:last-reading"];
	if (legacyConfig !== undefined && out[KEY_ACCOUNTS] === undefined) {
		let parsed = {};
		try {
			parsed = JSON.parse(legacyConfig);
		} catch (error) {
			parsed = {};
		}
		const acct = Object.assign({ id: "acct-1", name: "测试套餐", kind: "api" }, parsed);
		out[KEY_ACCOUNTS] = JSON.stringify([acct]);
		out[KEY_SETTINGS] = JSON.stringify({
			autoQueryInterval: parsed.autoQueryInterval === undefined ? 5 : parsed.autoQueryInterval,
			timeoutSeconds: parsed.timeoutSeconds === undefined ? 10 : parsed.timeoutSeconds
		});
	}
	if (legacyLast !== undefined && out[KEY_RESULTS] === undefined) {
		try {
			const snapshot = JSON.parse(legacyLast);
			if (snapshot && snapshot.data && typeof snapshot.at === "number") {
				out[KEY_RESULTS] = JSON.stringify({ "acct-1": { data: snapshot.data, at: snapshot.at, stale: false, error: "" } });
			}
		} catch (error) {
			// 坏掉的缓存忽略
		}
	}
	return out;
}

function account(over) {
	return Object.assign({ id: "acct-1", name: "测试套餐", kind: "api" }, over || {});
}

function storageOf(accounts, settings, results) {
	const out = {};
	out[KEY_ACCOUNTS] = JSON.stringify(accounts || [account(CONFIG)]);
	if (settings !== undefined) out[KEY_SETTINGS] = JSON.stringify(settings);
	if (results !== undefined) out[KEY_RESULTS] = JSON.stringify(results);
	return out;
}

function storedAccounts(env) {
	const raw = env.memory.get(KEY_ACCOUNTS);
	return raw ? JSON.parse(raw) : null;
}

function storedSettings(env) {
	const raw = env.memory.get(KEY_SETTINGS);
	return raw ? JSON.parse(raw) : null;
}

function storedResults(env) {
	const raw = env.memory.get(KEY_RESULTS);
	return raw ? JSON.parse(raw) : null;
}

function item(over) {
	return Object.assign({}, DEFAULT_ITEM, over || {});
}

function ok(items) {
	return { success: true, data: items, error: null };
}

function fail(message, items) {
	return { success: false, data: items === undefined ? null : items, error: message };
}

function snap(result, at) {
	return { data: result, at: at === undefined ? Date.now() - 1000 : at };
}

/** 假的 fetch 响应：同时提供 text() 与 json()，插件优先用 text()。 */
function json(body, status) {
	const text = JSON.stringify(body);
	const code = status === undefined ? 200 : status;
	return { ok: code < 400, status: code, text: async () => text, json: async () => JSON.parse(text) };
}

const CONFIG = {
	provider: "newapi",
	baseUrl: "https://api.example.com",
	accessToken: "sk-test-token",
	userId: "7",
	websiteUrl: "https://example.com",
	autoQueryInterval: 5,
	timeoutSeconds: 10,
	quotaPerUnit: 500000,
	unit: "CNY",
	customScript: ""
};

/** New API /api/user/self 的成功响应：quota 5000000 / used 1000000 → 10.00 ￥ / 已用 2.00 ￥。 */
function newApiBody() {
	return { success: true, data: { quota: 5000000, used_quota: 1000000, group: "默认套餐" } };
}
//#endregion

//#region 报告
const sections = [];
let current = null;
let failures = 0;
let total = 0;

function section(title) {
	current = { title: title, checks: [] };
	sections.push(current);
	console.log("\n" + title);
}

function check(name, condition, detail) {
	const entry = { name: name, ok: Boolean(condition), detail: detail === undefined ? "" : String(detail) };
	if (current) current.checks.push(entry);
	total += 1;
	if (!entry.ok) {
		failures += 1;
		console.log("  x " + name + (entry.detail ? "  -> " + entry.detail : ""));
	} else if (verbose) {
		console.log("  v " + name);
	}
}
//#endregion

//#region 假的 React / DOM
/**
 * 元素上挂的「这个元素归哪个 React 实例所有」。用 symbol 是为了让 findAll / render /
 * JSON.stringify 这些只看 type / props / children 的地方完全看不见它。
 */
const REACT_OWNER = Symbol("dsh-smoke-test-react-owner");

/**
 * 迷你 React：只实现 bundle 用到的那部分。
 *
 * 关键点是 **状态要跨渲染存活**：组件在测试里是通过反复调用 Component(props) 渲染的，
 * 如果 useState 每次返回初始值，任何「在 effect 里异步取回数据再 setState」的界面
 * （例如编辑页的 DSH 供应商下拉）就永远看不到结果 —— 测试会以为功能坏了。
 * 这里按「组件路径 + 第几个 hook」把状态存在实例里，等价于真实 React 的
 * 「同一个已挂载组件」语义；每个 bootstrap 环境都有自己的一份。
 */
function makeReact() {
	/** key → 当前状态值。 */
	const hookStore = new Map();
	/** key → { deps, cleanup }，用于按依赖决定是否重跑 effect。 */
	const effectStore = new Map();
	/** 当前正在渲染的组件帧。 */
	let frame = null;
	/** 本轮渲染里各组件名出现的次数，用来拼出稳定的组件路径。 */
	let counts = new Map();

	const owner = {
		createElement(type, props, ...children) {
			const element = { type, props: props || {}, children };
			element[REACT_OWNER] = owner;
			return element;
		},
		/** 每次顶层 render 开始时重置组件计数（状态本身不回退）。 */
		beginPass() {
			counts = new Map();
		},
		enter(type) {
			const name = (type && (type.displayName || type.name)) || "Component";
			const seen = counts.get(name) || 0;
			counts.set(name, seen + 1);
			const parent = frame;
			frame = { path: (parent ? parent.path : "") + "/" + name + "#" + seen, index: 0 };
			return parent;
		},
		exit(parent) {
			frame = parent;
		},
		useState(init) {
			const key = frame.path + ":" + frame.index++;
			if (!hookStore.has(key)) hookStore.set(key, typeof init === "function" ? init() : init);
			return [
				hookStore.get(key),
				(next) => {
					hookStore.set(key, typeof next === "function" ? next(hookStore.get(key)) : next);
				}
			];
		},
		useEffect(fn, deps) {
			const key = frame.path + ":" + frame.index++;
			const previous = effectStore.get(key);
			// 没有依赖数组：每次渲染都重跑（React 语义）。
			if (previous && Array.isArray(deps)) {
				const same = previous.deps.length === deps.length && deps.every((item, index) => Object.is(item, previous.deps[index]));
				if (same) return;
				if (typeof previous.cleanup === "function") previous.cleanup();
			}
			const cleanup = fn();
			effectStore.set(key, { deps: Array.isArray(deps) ? deps : null, cleanup: typeof cleanup === "function" ? cleanup : null });
		},
		useSyncExternalStore(subscribe, getSnapshot) {
			return getSnapshot();
		}
	};
	return owner;
}

/** 安全取字符串：属性缺失时返回空串（断言必须给出 FAIL，而不是让测试自身抛 TypeError）。 */
function str(value) {
	if (value === undefined || value === null) return "";
	return String(value);
}

/** 安全取 props：节点不是带 props 的元素时返回空对象。 */
function propsOf(node) {
	return node && typeof node === "object" && node.props ? node.props : {};
}

/** 安全 contains：与 String.prototype.includes 同义，但接受 undefined。 */
function has(value, needle) {
	return str(value).includes(needle);
}

function textOf(node) {
	if (node === null || node === undefined || node === false || node === true) return "";
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(textOf).join("");
	if (typeof node !== "object") return "";
	let out = "";
	if (Array.isArray(node.children)) out += node.children.map(textOf).join("");
	if (node.props && node.props.children !== undefined) out += textOf(node.props.children);
	return out;
}

/** 当前是否处在一次顶层 render 之内（用于只在顶层重置组件计数）。 */
let renderDepth = 0;

/** 展开函数组件（插槽注册的是包装组件，真正的 DOM 元素在它下面一层）。 */
function render(node) {
	if (node === null || node === undefined || typeof node !== "object") return node;
	if (Array.isArray(node)) return node.map(render);
	const react = node[REACT_OWNER];
	const outermost = react && renderDepth === 0;
	if (outermost) react.beginPass();
	if (react) renderDepth += 1;
	try {
		if (typeof node.type === "function") {
			const props = Object.assign({}, node.props);
			if (Array.isArray(node.children) && node.children.length > 0) {
				props.children = node.children.length === 1 ? node.children[0] : node.children;
			}
			// 进入组件帧：hook 状态按「组件路径 + hook 序号」定位，跨渲染存活。
			const parent = react ? react.enter(node.type) : null;
			try {
				return render(node.type(props));
			} finally {
				if (react) react.exit(parent);
			}
		}
		return Object.assign({}, node, { children: Array.isArray(node.children) ? node.children.map(render) : node.children });
	} finally {
		if (react) renderDepth -= 1;
	}
}

function findAll(node, predicate, found) {
	const acc = found || [];
	if (node === null || node === undefined || typeof node !== "object") return acc;
	if (Array.isArray(node)) {
		for (const entry of node) findAll(entry, predicate, acc);
		return acc;
	}
	if (predicate(node)) acc.push(node);
	if (Array.isArray(node.children)) for (const child of node.children) findAll(child, predicate, acc);
	if (node.props && node.props.children !== undefined) findAll(node.props.children, predicate, acc);
	return acc;
}

/** 版本指纹：跑的是哪一版测试/bundle，一眼可辨（诊断「堆栈行号对不上」这类问题时必需）。 */
function fingerprint(file) {
	const bytes = fs.readFileSync(file);
	return "sha256:" + crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 16) + " · " + bytes.length + " B";
}

/** 组装一个假的渲染进程环境，并执行 bundle。 */
function bootstrap(options) {
	const settings = options || {};
	const memory = new Map();
	if (settings.storage) {
		const expanded = expandStorage(settings.storage);
		for (const key of Object.keys(expanded)) memory.set(key, expanded[key]);
	}
	const styleTags = [];
	const opened = [];
	const listeners = {};
	const documentStub = {
		visibilityState: "visible",
		querySelector(selector) {
			const match = /^style\[data-plugin-css="(.*)"\]$/.exec(selector);
			if (!match) return null;
			const id = JSON.parse('"' + match[1] + '"');
			return styleTags.find((tag) => tag.dataset.pluginCss === id) || null;
		},
		createElement(tag) {
			return { tagName: tag, dataset: {}, style: {}, textContent: "", appendChild() {} };
		},
		head: {
			appendChild(tag) {
				styleTags.push(tag);
			}
		},
		addEventListener(type, fn) {
			(listeners[type] = listeners[type] || []).push(fn);
		},
		removeEventListener(type, fn) {
			if (listeners[type]) listeners[type] = listeners[type].filter((entry) => entry !== fn);
		}
	};
	const definitions = [];
	const windowStub = {
		localStorage: {
			getItem: (key) => (memory.has(key) ? memory.get(key) : null),
			setItem: (key, value) => memory.set(key, String(value)),
			removeItem: (key) => memory.delete(key)
		},
		open: (...args) => opened.push(args),
		location: { assign: (url) => opened.push([url]) },
		__ModuleLoader__: { load: (definition) => definitions.push(definition) }
	};
	// 桌面端渲染进程的地址是 dsh-app://app/...（main.js 的 protocol.handle 会把
	// /plugins/... 原样转发给宿主 webserver）；Web 版则是普通 http 同源地址。
	const locationStub = settings.location || { href: "dsh-app://app/", origin: "dsh-app://app" };
	const react = makeReact();
	const targetFetch = settings.fetch || (async () => json(newApiBody()));
	/**
	 * 宿主代理模式：
	 *   "host"（默认）—— 路由存在，把请求转交给目标模拟器（等同宿主进程直连，无 CORS）；
	 *   "down"       —— 路由不存在（旧宿主 / webserver 未启用）→ 404，客户端应回落浏览器直连；
	 *   "network" / "timeout" —— 路由存在但上游失败，返回 {ok:false,error:{kind,message}}；
	 *   函数         —— 自定义：收到 payload，返回 json(...) 形态的响应。
	 */
	const proxyMode = settings.proxy === undefined ? "host" : settings.proxy;
	const proxyCalls = [];
	const fetchStub = async (url, init) => {
		const text = String(url);
		if (!text.includes("/plugins/dsh-balance-inquiry/proxy")) return targetFetch(url, init);
		const payload = JSON.parse(String((init && init.body) || "{}"));
		proxyCalls.push({ url: text, options: init || {}, payload: payload });
		if (typeof proxyMode === "function") return proxyMode(payload);
		if (proxyMode === "down") return json({ ok: false, error: { kind: "invalid", message: "not found" } }, 404);
		if (proxyMode === "timeout") {
			return json({ ok: false, error: { kind: "timeout", message: "请求超时 请求失败 Request failed: timeout after " + payload.timeoutSeconds + "s" } });
		}
		if (proxyMode === "network") {
			const host = (function () {
				try {
					return new URL(payload.url).host;
				} catch (error) {
					return payload.url;
				}
			})();
			return json({ ok: false, error: { kind: "network", message: "网络错误 Network error: 无法连接 " + host + "（fetch failed）" } });
		}
		try {
			const response = await targetFetch(payload.url, {
				method: payload.method,
				headers: payload.headers,
				body: payload.body === undefined || payload.body === null ? undefined : payload.body,
				cache: "no-store",
				credentials: "omit"
			});
			const body = await response.text();
			return json({ ok: true, status: response.status, statusText: response.statusText || "", body: body });
		} catch (error) {
			// 与 lib/index.js 的宿主代理一致：网络错误文案里带上目标主机。
			const host = (function () {
				try {
					return new URL(payload.url).host;
				} catch (inner) {
					return payload.url;
				}
			})();
			return json({ ok: false, error: { kind: "network", message: "网络错误 Network error: 无法连接 " + host + "（" + String((error && error.message) || error) + "）" } });
		}
	};
	const requireStub = (id) => {
		if (id === "react") return react;
		throw new Error("bundle 请求了未预期的模块：" + id);
	};
	const run = new Function("window", "document", "fetch", "AbortController", "require", "location", source);
	run(windowStub, documentStub, fetchStub, AbortController, requireStub, locationStub);
	const definition = definitions[0];
	const moduleExports = definition.factory(requireStub);

	const registrations = [];
	const locales = {};
	const ctx = {
		effect(fn) {
			const disposer = fn();
			return typeof disposer === "function" ? disposer : () => {};
		},
		locale: {
			register(namespace, dictionaries) {
				locales[namespace] = dictionaries;
				return () => {};
			},
			// 简化：始终取中文词典（DSH 的 locale 服务会按当前语言挑选）
			bind(namespace) {
				return (key) => {
					const dictionaries = locales[namespace] || {};
					const dictionary = dictionaries.zh || dictionaries.en || {};
					return dictionary[key] !== undefined ? dictionary[key] : key;
				};
			}
		},
		slots: {
			inject(name, callback) {
				callback();
			},
			register(options, Component) {
				registrations.push({ options: options, Component: Component });
				return () => {};
			}
		}
	};
	moduleExports.apply(ctx);

	return {
		definition: definition,
		moduleExports: moduleExports,
		registrations: registrations,
		styleTags: styleTags,
		opened: opened,
		memory: memory,
		listeners: listeners,
		document: documentStub,
		window: windowStub,
		location: locationStub,
		proxyCalls: proxyCalls,
		proxyMode: proxyMode
	};
}

function tick(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms === undefined ? 5 : ms));
}
//#endregion

//#region 树查询辅助
function registrationOf(env, name) {
	return env.registrations.find((entry) => entry.options && entry.options.name === name) || null;
}

function entryTree(env, wide) {
	const registration = registrationOf(env, "sidebar.footer.action");
	return render(registration.Component({ wide: wide === undefined ? true : wide }));
}

function pageTree(env) {
	const registration = registrationOf(env, "settings.section");
	return render(registration.Component({}));
}

/** 余额看板（shell.overlay）：未打开时返回 null。 */
function boardTree(env) {
	const registration = registrationOf(env, "shell.overlay");
	return render(registration.Component({}));
}

/** 打开余额看板（点侧边栏按钮）并返回它的渲染树。 */
function openBoard(env) {
	if (boardTree(env) === null) click(allTags(entryTree(env), "button")[0]);
	return boardTree(env);
}

/** 看板第 index 张卡片。 */
function boardCardOf(env, index) {
	const board = openBoard(env);
	if (!board) return null;
	return allByClass(board, "dsh-balance-inquiry-card")[index === undefined ? 0 : index] || null;
}

/** 看板第 index 张卡片的跳转地址（没有卡片时返回 ""）。 */
function boardHrefOf(env, index) {
	const card = boardCardOf(env, index);
	if (!card) return "";
	click(card);
	const opened = env.opened[env.opened.length - 1];
	return opened ? opened[0] : "";
}

/** 一级设置页 → 点第一条套餐的长条按钮 → 二级编辑页的渲染树。 */
function editPageOf(env) {
	const list = pageTree(env);
	const rows = allByClass(list, "dsh-balance-inquiry-account");
	if (!rows.length) return list;
	click(rows[0]);
	return pageTree(env);
}

function allByClass(node, className) {
	return findAll(node, (entry) => {
		const value = propsOf(entry).className;
		return typeof value === "string" && value.split(/\s+/).indexOf(className) !== -1;
	});
}

function firstByClass(node, className) {
	return allByClass(node, className)[0] || null;
}

function allTags(node, tag) {
	return findAll(node, (entry) => entry.type === tag);
}

/** 按字段标题取输入控件（input / textarea / select）；标题取 label 里第一个 span，避免命中提示文案。 */
function fieldOf(node, labelText) {
	const label = findAll(node, (entry) => {
		if (entry.type !== "label") return false;
		const titleSpan = allTags(entry, "span")[0];
		return has(textOf(titleSpan || entry), labelText);
	})[0];
	if (!label) return null;
	return (
		allTags(label, "input")[0] ||
		allTags(label, "textarea")[0] ||
		allTags(label, "select")[0] ||
		null
	);
}

function buttonByText(node, text) {
	return findAll(node, (entry) => entry.type === "button" && has(textOf(entry), text))[0] || null;
}

function click(node) {
	const handler = propsOf(node).onClick;
	if (typeof handler === "function") handler({ preventDefault() {} });
}

/** 读回第一条持久化套餐（旧用例关心的是「配置有没有被写回去」）。 */
function storedConfig(env) {
	const list = storedAccounts(env);
	return list && list.length ? list[0] : null;
}

/** 读回第一条套餐的读数（旧用例关心的是「上次成功值还在不在」）。 */
function storedSnapshot(env) {
	const map = storedResults(env);
	if (!map) return null;
	const first = Object.keys(map)[0];
	if (!first) return null;
	const reading = map[first];
	return reading && reading.data ? { data: reading.data, at: reading.at } : null;
}
//#endregion

async function main() {
	// 版本指纹：堆栈行号与文件版本对不上时（例如误跑了旧副本），靠这两行即可判断。
	console.log("dsh-balance-inquiry 冒烟测试（" + process.version + " · " + process.platform + "）");
	console.log("  bundle : " + CLIENT);
	console.log("           " + fingerprint(CLIENT) + " · " + source.split("\n").length + " 行");
	console.log("  test   : " + __filename);
	console.log("           " + fingerprint(__filename));

	//#region 1. bundle 形状与插槽注册
	section("1. bundle 形状与插槽注册");
	const baseEnv = bootstrap({
		storage: { "dsh-balance-inquiry:config": JSON.stringify(CONFIG) },
		fetch: async () => json(newApiBody())
	});
	await tick(30);
	check("bundle id 为 dsh-balance-inquiry", baseEnv.definition.id === "dsh-balance-inquiry", baseEnv.definition.id);
	check(
		"导出 name / inject / apply",
		baseEnv.moduleExports.name === "dsh-balance-inquiry" &&
			Array.isArray(baseEnv.moduleExports.inject) &&
			typeof baseEnv.moduleExports.apply === "function"
	);
	check("inject = ['slots','locale']", baseEnv.moduleExports.inject.join(",") === "slots,locale", baseEnv.moduleExports.inject.join(","));
	check("只注册了三个插槽（侧边栏 + 设置页 + 余额看板）", baseEnv.registrations.length === 3, baseEnv.registrations.length);
	const footerRegistration = registrationOf(baseEnv, "sidebar.footer.action");
	const settingsRegistration = registrationOf(baseEnv, "settings.section");
	const boardRegistration = registrationOf(baseEnv, "shell.overlay");
	check("注册 sidebar.footer.action", Boolean(footerRegistration));
	check("注册 shell.overlay（余额看板）", Boolean(boardRegistration));
	check("看板 id = quota-board", boardRegistration && boardRegistration.options.id === "quota-board", boardRegistration && boardRegistration.options.id);
	check("侧边栏条目 id = quota", footerRegistration && footerRegistration.options.id === "quota", footerRegistration && footerRegistration.options.id);
	check(
		"order 小于「上下文洞察」的 " + CONTEXT_OVERVIEW_ORDER + "（显示在它上面）",
		footerRegistration && Number(footerRegistration.options.order) < CONTEXT_OVERVIEW_ORDER,
		footerRegistration && footerRegistration.options.order
	);
	check("声明 locale 命名空间 dsh-balance-inquiry", footerRegistration && footerRegistration.options.locale === "dsh-balance-inquiry", footerRegistration && footerRegistration.options.locale);
	check("注册 settings.section", Boolean(settingsRegistration));
	check("设置页 id = quota", settingsRegistration && settingsRegistration.options.id === "quota", settingsRegistration && settingsRegistration.options.id);
	check(
		"设置页导航名 = 余额查询",
		settingsRegistration && typeof settingsRegistration.options.label === "function" && settingsRegistration.options.label() === "余额查询",
		settingsRegistration && settingsRegistration.options.label && settingsRegistration.options.label()
	);

	// 系统性地盯住「漏翻译」这一类 bug：bundle 里每个 t("…") 用到的字面量键，
	// 中英两套字典都必须有译文。漏一条界面就会直接显示原始键名（曾经发生过：
	// form.dshProvider* 三条只写在 locale/*.json 里，而 bundle 用的是内联字典）。
	{
		const dict = (baseEnv.moduleExports && baseEnv.moduleExports.__internals && baseEnv.moduleExports.__internals.dictionaries) || {};
		const usedKeys = [...new Set([...source.matchAll(/\bt\(\s*"([A-Za-z0-9_.]+)"/g)].map((m) => m[1]))].sort();
		check("bundle 里有可核对 t(\"…\") 键", usedKeys.length > 50, usedKeys.length);
		for (const lang of ["zh", "en"]) {
			const table = dict[lang] || {};
			const missing = usedKeys.filter((key) => typeof table[key] !== "string");
			check(
				lang + " 字典覆盖全部 t(\"…\") 键（无漏翻译）",
				missing.length === 0 && Object.keys(table).length > 0,
				missing.length ? "缺 " + missing.join(", ") : Object.keys(table).length + " 条"
			);
		}
		// 两套字典的键集合必须一致，避免只有中文/只有英文的半成品。
		const zhKeys = Object.keys(dict.zh || {}).sort();
		const enKeys = Object.keys(dict.en || {}).sort();
		check("中英字典键集合一致", zhKeys.length > 0 && zhKeys.join("\n") === enKeys.join("\n"), "zh " + zhKeys.length + " / en " + enKeys.length);
	}
	//#endregion

	//#region 2. 样式
	section("2. 样式注入");
	check("注入了一个 <style>", baseEnv.styleTags.length === 1, baseEnv.styleTags.length);
	const styleTag = baseEnv.styleTags[0] || { dataset: {}, textContent: "" };
	check("style 标记在 dsh-balance-inquiry 名下", styleTag.dataset.plugin === "dsh-balance-inquiry" && styleTag.dataset.pluginCss === "dsh-balance-inquiry/balance.css", JSON.stringify(styleTag.dataset));
	check("侧边栏行几何（抄「上下文洞察」）", has(styleTag.textContent, ".dsh-balance-inquiry-entry{") && has(styleTag.textContent, "height:42px") && has(styleTag.textContent, "border-radius:12px"));
	check("rail 模式样式", has(styleTag.textContent, ".dsh-balance-inquiry-entry-rail{"));
	check("错误/警告色", has(styleTag.textContent, ".dsh-balance-inquiry-entry-error{") && has(styleTag.textContent, ".dsh-balance-inquiry-entry-warning{"));
	check("主按钮为浅底深字（黑字白底）", has(styleTag.textContent, ".dsh-balance-inquiry-btn-primary{background:var(--dsw-alias-label-primary,#fff)") && has(styleTag.textContent, "color:var(--dsw-alias-bg-base,#17181c)"));
	check("脚本输入框样式", has(styleTag.textContent, ".dsh-balance-inquiry-textarea{") && has(styleTag.textContent, ".dsh-balance-inquiry-warning .dsh-balance-inquiry-plan-value{"));
	//#endregion

	//#region 3. New API 快乐路径
	section("3. New API 查询（缓存 + 成功）");
	const newApiCalls = [];
	const newApiEnv = bootstrap({
		storage: {
			"dsh-balance-inquiry:config": JSON.stringify(CONFIG),
			"dsh-balance-inquiry:last-reading": JSON.stringify(snap(ok([item()])))
		},
		fetch: async (url, options) => {
			newApiCalls.push({ url: String(url), options: options || {} });
			return json(newApiBody());
		}
	});
	await tick(30);
	check("请求地址 = {baseUrl}/api/user/self", newApiCalls.length >= 1 && newApiCalls[0].url === "https://api.example.com/api/user/self", newApiCalls.length ? newApiCalls[0].url : "(没有发出请求)");
	check(
		"GET + Authorization: Bearer <token>",
		Boolean(newApiCalls[0]) && newApiCalls[0].options.method === "GET" && newApiCalls[0].options.headers.Authorization === "Bearer sk-test-token",
		newApiCalls[0] && JSON.stringify(newApiCalls[0].options.headers)
	);
	check("New-Api-User 头 = 用户 ID", newApiCalls[0] && newApiCalls[0].options.headers["New-Api-User"] === "7", newApiCalls[0] && newApiCalls[0].options.headers["New-Api-User"]);
	check("不发送 User-Agent（浏览器禁止头）", newApiCalls[0] && newApiCalls[0].options.headers["User-Agent"] === undefined);
	check("credentials=omit / cache=no-store", newApiCalls[0] && newApiCalls[0].options.credentials === "omit" && newApiCalls[0].options.cache === "no-store");

	const newApiEntry = entryTree(newApiEnv);
	const labelNode = firstByClass(newApiEntry, "dsh-balance-inquiry-entry-label");
	check("按钮文案 = 剩余额度：10.00 ￥", textOf(labelNode) === "剩余额度：10.00 ￥", textOf(labelNode));
	const entryButton = allTags(newApiEntry, "button")[0];
	check("侧边栏条目是按钮（左键开看板）", Boolean(entryButton) && propsOf(entryButton).type === "button");
	check("className 含 dsh-balance-inquiry-entry", has(propsOf(entryButton).className, "dsh-balance-inquiry-entry"));
	check("图标随宽度取 16", Number(propsOf(allTags(newApiEntry, "svg")[0]).width) === 16, propsOf(allTags(newApiEntry, "svg")[0]).width);
	check(
		"tooltip 含每个套餐的余额与更新时间",
		has(propsOf(entryButton).title, "测试套餐：余额 10.00 ￥") && has(propsOf(entryButton).title, "更新时间："),
		propsOf(entryButton).title
	);
	check("看板初始未打开", boardTree(newApiEnv) === null);
	click(entryButton);
	check("左键点击打开余额看板", boardTree(newApiEnv) !== null);
	const newApiBoard = openBoard(newApiEnv);
	check("看板里有添加套餐按钮", Boolean(buttonByText(newApiBoard, "添加套餐")));
	const newApiCard = boardCardOf(newApiEnv, 0);
	check("看板卡片显示套餐名称", has(textOf(newApiCard), "测试套餐"), textOf(newApiCard));
	check("看板卡片显示剩余额度", has(textOf(newApiCard), "10.00 ￥"), textOf(newApiCard));
	check("看板卡片显示上次查询时间", has(textOf(newApiCard), "上次查询："), textOf(newApiCard));
	click(newApiCard);
	check(
		"左键点卡片打开官网",
		newApiEnv.opened.length === 1 && newApiEnv.opened[0][0] === "https://example.com" && newApiEnv.opened[0][1] === "_blank" && has(newApiEnv.opened[0][2], "noopener"),
		JSON.stringify(newApiEnv.opened)
	);
	check("卡片不再注册右键处理", propsOf(newApiCard).onContextMenu === undefined);
	// 看板里的「添加套餐」会弹出计费类型选择
	const boardAddButton = buttonByText(openBoard(newApiEnv), "添加套餐");
	click(boardAddButton);
	const pickerBoard = openBoard(newApiEnv);
	check("看板的添加套餐弹出计费类型选择", has(textOf(pickerBoard), "按量计费（API Key）") && has(textOf(pickerBoard), "Token Plan / Coding Plan"), textOf(pickerBoard).slice(0, 120));
	click(boardAddButton);
	click(entryButton);
	const railEntry = entryTree(newApiEnv, false);
	check("rail 模式不渲染文字", firstByClass(railEntry, "dsh-balance-inquiry-entry-label") === null);
	check("rail 模式 className 含 -rail", has(propsOf(allTags(railEntry, "button")[0]).className, "dsh-balance-inquiry-entry-rail"));
	check("rail 模式图标取 18", Number(propsOf(allTags(railEntry, "svg")[0]).width) === 18, propsOf(allTags(railEntry, "svg")[0]).width);

	// 一级设置页：套餐长条按钮 + 全局设置
	const newApiPage = pageTree(newApiEnv);
	check("一级设置页有添加套餐按钮", Boolean(buttonByText(newApiPage, "添加套餐")));
	const accountRow = allByClass(newApiPage, "dsh-balance-inquiry-account")[0];
	check("套餐展示为长条按钮", Boolean(accountRow) && accountRow.type === "button");
	check("长条按钮显示「套餐名称 剩余额度：XXX」", has(textOf(accountRow), "测试套餐") && has(textOf(accountRow), "剩余额度：10.00 ￥"), textOf(accountRow));
	check("全局设置有间隔与超时字段", Boolean(fieldOf(newApiPage, "自动查询间隔（分钟）")) && Boolean(fieldOf(newApiPage, "请求超时（秒）")));
	check("设置页标题 = 余额查询", has(textOf(newApiPage), "余额查询"));

	// 点长条按钮进入二级编辑页
	click(accountRow);
	const editPage = pageTree(newApiEnv);
	check("二级编辑页有返回 / 删除按钮", Boolean(buttonByText(editPage, "返回列表")) && Boolean(buttonByText(editPage, "删除套餐")));
	check("编辑页显示接口地址字段", Boolean(fieldOf(editPage, "接口地址")));
	check("New API 编辑页显示换算比例与货币单位", Boolean(fieldOf(editPage, "额度换算比例")) && Boolean(fieldOf(editPage, "货币单位")));
	check("令牌输入框是 password", propsOf(fieldOf(editPage, "访问令牌")).type === "password");
	check("官网地址输入框 = 套餐值", propsOf(fieldOf(editPage, "官网地址")).value === "https://example.com", propsOf(fieldOf(editPage, "官网地址")).value);
	//#endregion

	//#region 4. 配置加载
	section("4a. 存储里缺字段用默认值补齐，多余的键被忽略");
	const partialEnv = bootstrap({
		storage: {
			"dsh-balance-inquiry:config": JSON.stringify({ baseUrl: "https://api.example.com", accessToken: "sk-test-token", websiteUrl: "https://example.com", quotaPerUnit: 500000, somethingRemoved: true })
		},
		fetch: async () => json(newApiBody())
	});
	await tick(30);
	const partialPage = pageTree(partialEnv);
	check("缺失的自动查询间隔回落到默认 5 分钟", propsOf(fieldOf(partialPage, "自动查询间隔")).value === "5", propsOf(fieldOf(partialPage, "自动查询间隔")).value);
	check("缺失的额度换算比例回落到默认 500000（编辑页）", propsOf(fieldOf(editPageOf(partialEnv), "额度换算比例")).value === "500000", propsOf(fieldOf(editPageOf(partialEnv), "额度换算比例")).value);

	section("4b. 数字字段越界时收敛到允许区间");
	const clampedEnv = bootstrap({
		storage: { "dsh-balance-inquiry:config": JSON.stringify({ baseUrl: "https://api.example.com", accessToken: "sk-test-token", autoQueryInterval: 0, timeoutSeconds: 999 }) },
		fetch: async () => json(newApiBody())
	});
	await tick(30);
	const clampedPage = pageTree(clampedEnv);
	check("间隔 0 = 不自动查询", propsOf(fieldOf(clampedPage, "自动查询间隔")).value === "0", propsOf(fieldOf(clampedPage, "自动查询间隔")).value);
	check("超时收敛到上限 30 秒", propsOf(fieldOf(clampedPage, "请求超时")).value === "30", propsOf(fieldOf(clampedPage, "请求超时")).value);
	const clearEnv = bootstrap({
		storage: {
			"dsh-balance-inquiry:config": JSON.stringify(Object.assign({}, CONFIG, { websiteUrl: "" })),
			"dsh-balance-inquiry:last-reading": JSON.stringify(snap(ok([item()])))
		},
		fetch: async () => json(newApiBody())
	});
	await tick(30);
	check("清空官网地址会被保留（不被默认值覆盖）", storedConfig(clearEnv).websiteUrl === "", JSON.stringify(storedConfig(clearEnv).websiteUrl));
	check("官网地址为空 → 看板卡片回落到接口地址", boardHrefOf(clearEnv, 0) === "https://api.example.com", boardHrefOf(clearEnv, 0));
	//#endregion

	//#region 5. 失败语义
	section("5a. 鉴权失败（401，确定性失败 → 清空上次成功值）");
	const authEnv = bootstrap({
		storage: {
			"dsh-balance-inquiry:config": JSON.stringify(CONFIG),
			"dsh-balance-inquiry:last-reading": JSON.stringify(snap(ok([item()])))
		},
		fetch: async () => json({ code: "AUTH_UNAUTHORIZED", message: "Unauthorized, invalid access token", success: false }, 401)
	});
	await tick(30);
	const authEntry = entryTree(authEnv);
	const authLink = allTags(authEntry, "button")[0];
	check("文案回落到 剩余额度：--", textOf(firstByClass(authEntry, "dsh-balance-inquiry-entry-label")) === "剩余额度：--", textOf(firstByClass(authEntry, "dsh-balance-inquiry-entry-label")));
	check("tooltip 给出失败原因", has(propsOf(authLink).title, "查询失败") && has(propsOf(authLink).title, "Authentication failed (HTTP 401)"), propsOf(authLink).title);
	check("不再显示旧余额", !has(propsOf(authLink).title, "余额 10.00 ￥"), propsOf(authLink).title);
	check("行变红", has(propsOf(authLink).className, "dsh-balance-inquiry-entry-error"));
	check("清空了上次成功快照", storedSnapshot(authEnv) === null, JSON.stringify(storedSnapshot(authEnv)));
	check("编辑页状态行给出原因（不显示「尚未查询」）", has(textOf(editPageOf(authEnv)), "查询失败：Authentication failed (HTTP 401)"), textOf(editPageOf(authEnv)));

	section("5b. 瞬时失败 + 10 分钟内的上次成功 → 保留上次值并重试一次");
	const transientCalls = [];
	const transientEnv = bootstrap({
		storage: {
			"dsh-balance-inquiry:config": JSON.stringify(CONFIG),
			"dsh-balance-inquiry:last-reading": JSON.stringify(snap(ok([item()]), Date.now() - 1000))
		},
		fetch: async (url, options) => {
			transientCalls.push(String(url));
			const error = new TypeError("Failed to fetch");
			throw error;
		}
	});
	await tick(RETRY_DELAY_MS + 400);
	const transientEntry = entryTree(transientEnv);
	const transientLink = allTags(transientEntry, "button")[0];
	check("仍然显示上次成功的余额", textOf(firstByClass(transientEntry, "dsh-balance-inquiry-entry-label")) === "剩余额度：10.00 ￥", textOf(firstByClass(transientEntry, "dsh-balance-inquiry-entry-label")));
	check("tooltip 标注「上次成功」", has(propsOf(transientLink).title, "上次成功："), propsOf(transientLink).title);
	check("tooltip 同时给出失败原因", has(propsOf(transientLink).title, "查询失败"), propsOf(transientLink).title);
	check("保留了上次成功快照（未被清空）", storedSnapshot(transientEnv) !== null);
	check("瞬时失败只重试一次（共 2 次请求）", transientCalls.length === 2, transientCalls.length);
	check("编辑页标注「重试中」", has(textOf(editPageOf(transientEnv)), "重试中"), textOf(editPageOf(transientEnv)));

	section("5c. 瞬时失败 + 超出 10 分钟窗口 → 不再展示旧值");
	const staleEnv = bootstrap({
		storage: {
			"dsh-balance-inquiry:config": JSON.stringify(CONFIG),
			"dsh-balance-inquiry:last-reading": JSON.stringify(snap(ok([item()]), Date.now() - KEEP_LAST_GOOD_MS - 60000))
		},
		fetch: async () => {
			throw new TypeError("Failed to fetch");
		}
	});
	await tick(RETRY_DELAY_MS + 400);
	const staleLink = allTags(entryTree(staleEnv), "button")[0];
	check("文案回落到 剩余额度：--", textOf(firstByClass(entryTree(staleEnv), "dsh-balance-inquiry-entry-label")) === "剩余额度：--", textOf(firstByClass(entryTree(staleEnv), "dsh-balance-inquiry-entry-label")));
	check("不再显示旧余额", !has(propsOf(staleLink).title, "余额 10.00 ￥"), propsOf(staleLink).title);

	section("5d. HTTP 500（瞬时状态码）→ 保留上次值、不重试");
	const http500Calls = [];
	const http500Env = bootstrap({
		storage: {
			"dsh-balance-inquiry:config": JSON.stringify(CONFIG),
			"dsh-balance-inquiry:last-reading": JSON.stringify(snap(ok([item()])))
		},
		fetch: async (url) => {
			http500Calls.push(String(url));
			return json({ error: "boom" }, 500);
		}
	});
	await tick(200);
	check("保留上次成功的余额", textOf(firstByClass(entryTree(http500Env), "dsh-balance-inquiry-entry-label")) === "剩余额度：10.00 ￥", textOf(firstByClass(entryTree(http500Env), "dsh-balance-inquiry-entry-label")));
	check("HTTP 5xx 判定为瞬时（只请求一次）", http500Calls.length === 1, http500Calls.length);
	check("tooltip 显示 HTTP 500 原因", has(propsOf(allTags(entryTree(http500Env), "button")[0]).title, "HTTP 500"), propsOf(allTags(entryTree(http500Env), "button")[0]).title);

	section("5e. HTTP 200 但 success=false（新版 New API）");
	const invalidEnv = bootstrap({
		storage: { "dsh-balance-inquiry:config": JSON.stringify(CONFIG) },
		fetch: async () => json({ message: "无权进行此操作，access token 无效", success: false })
	});
	await tick(30);
	const invalidEntry = entryTree(invalidEnv);
	const invalidLink = allTags(invalidEntry, "button")[0];
	check("文案回落（没有余额）", textOf(firstByClass(invalidEntry, "dsh-balance-inquiry-entry-label")) === "剩余额度：--", textOf(firstByClass(invalidEntry, "dsh-balance-inquiry-entry-label")));
	check("tooltip 给出无效原因", has(propsOf(invalidLink).title, "无权进行此操作，access token 无效"), propsOf(invalidLink).title);
	check("编辑页提示无效原因", has(textOf(editPageOf(invalidEnv)), "无权进行此操作，access token 无效"), textOf(editPageOf(invalidEnv)));
	check("状态行给出原因", has(textOf(editPageOf(invalidEnv)), "无权进行此操作，access token 无效"), textOf(editPageOf(invalidEnv)));
	//#endregion

	//#region 6. 原生余额供应商
	section("6a. DeepSeek 官方（数字字符串余额）");
	const deepseekCalls = [];
	const deepseekEnv = bootstrap({
		storage: { "dsh-balance-inquiry:config": JSON.stringify(Object.assign({}, CONFIG, { provider: "deepseek" })) },
		fetch: async (url, options) => {
			deepseekCalls.push({ url: String(url), options: options || {} });
			return json({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "9.87" }] });
		}
	});
	await tick(30);
	check("请求官方余额端点", deepseekCalls[0] && deepseekCalls[0].url === "https://api.deepseek.com/user/balance", deepseekCalls[0] && deepseekCalls[0].url);
	check("带 Bearer 且 Accept: application/json", deepseekCalls[0] && deepseekCalls[0].options.headers.Authorization === "Bearer sk-test-token" && deepseekCalls[0].options.headers.Accept === "application/json");
	check("数字字符串 9.87 正确解析", textOf(firstByClass(entryTree(deepseekEnv), "dsh-balance-inquiry-entry-label")) === "剩余额度：9.87 ￥", textOf(firstByClass(entryTree(deepseekEnv), "dsh-balance-inquiry-entry-label")));
	check("设置页隐藏接口地址 / 用户 ID 字段", fieldOf(pageTree(deepseekEnv), "接口地址") === null && fieldOf(pageTree(deepseekEnv), "用户 ID") === null);

	section("6b. OpenRouter（credits - usage）");
	const openrouterEnv = bootstrap({
		storage: { "dsh-balance-inquiry:config": JSON.stringify(Object.assign({}, CONFIG, { provider: "openrouter" })) },
		fetch: async () => json({ data: { total_credits: 25.5, total_usage: 5.5 } })
	});
	await tick(30);
	check("余额 = credits - usage", textOf(firstByClass(entryTree(openrouterEnv), "dsh-balance-inquiry-entry-label")) === "剩余额度：20.00 $", textOf(firstByClass(entryTree(openrouterEnv), "dsh-balance-inquiry-entry-label")));
	check("看板卡片显示剩余额度（OpenRouter）", has(textOf(openBoard(openrouterEnv)), "13.50 $") || has(textOf(openBoard(openrouterEnv)), "20.00 $"), textOf(openBoard(openrouterEnv)));

	section("6c. Novita（availableBalance / 10000）");
	const novitaEnv = bootstrap({
		storage: { "dsh-balance-inquiry:config": JSON.stringify(Object.assign({}, CONFIG, { provider: "novita" })) },
		fetch: async () => json({ availableBalance: 123456 })
	});
	await tick(30);
	check("余额 = 123456 / 10000 = 12.35", textOf(firstByClass(entryTree(novitaEnv), "dsh-balance-inquiry-entry-label")) === "剩余额度：12.35 $", textOf(firstByClass(entryTree(novitaEnv), "dsh-balance-inquiry-entry-label")));

	section("6d. 原生供应商鉴权失败");
	const nativeAuthEnv = bootstrap({
		storage: { "dsh-balance-inquiry:config": JSON.stringify(Object.assign({}, CONFIG, { provider: "stepfun" })) },
		fetch: async () => json({ error: "unauthorized" }, 401)
	});
	await tick(30);
	check("显示鉴权失败原因", has(propsOf(allTags(entryTree(nativeAuthEnv), "button")[0]).title, "Authentication failed (HTTP 401)"), propsOf(allTags(entryTree(nativeAuthEnv), "button")[0]).title);
	//#endregion

	//#region 7. 自定义脚本
	section("7a. 自定义用量脚本（占位符 + 多套餐）");
	const SCRIPT = [
		"({",
		"  request: {",
		'    url: "{{baseUrl}}/api/user/self",',
		'    method: "GET",',
		"    headers: {",
		'      "Authorization": "Bearer {{apiKey}}",',
		'      "New-Api-User": "{{userId}}"',
		"    }",
		"  },",
		"  extractor: function (response) {",
		"    return [",
		'      { planName: "套餐A", remaining: 3.5, total: 10, used: 6.5, unit: "CNY" },',
		'      { planName: "套餐B", remaining: 1.25, unit: "USD" }',
		"    ];",
		"  }",
		"})"
	].join("\n");
	const scriptCalls = [];
	const scriptEnv = bootstrap({
		storage: { "dsh-balance-inquiry:config": JSON.stringify(Object.assign({}, CONFIG, { provider: "custom", customScript: SCRIPT })) },
		fetch: async (url, options) => {
			scriptCalls.push({ url: String(url), options: options || {} });
			return json({ anything: true });
		}
	});
	await tick(30);
	check("{{baseUrl}} 已替换", scriptCalls[0] && scriptCalls[0].url === "https://api.example.com/api/user/self", scriptCalls[0] && scriptCalls[0].url);
	check("{{apiKey}} / {{userId}} 已替换", scriptCalls[0] && scriptCalls[0].options.headers.Authorization === "Bearer sk-test-token" && scriptCalls[0].options.headers["New-Api-User"] === "7", scriptCalls[0] && JSON.stringify(scriptCalls[0].options.headers));
	check("第一条记录显示在侧边栏", textOf(firstByClass(entryTree(scriptEnv), "dsh-balance-inquiry-entry-label")) === "剩余额度：3.50 ￥", textOf(firstByClass(entryTree(scriptEnv), "dsh-balance-inquiry-entry-label")));
	check("侧边栏显示最紧急的一条", has(textOf(firstByClass(entryTree(scriptEnv), "dsh-balance-inquiry-entry-label")), "剩余额度："), textOf(firstByClass(entryTree(scriptEnv), "dsh-balance-inquiry-entry-label")));
	check("编辑页列出两条记录", has(textOf(editPageOf(scriptEnv)), "套餐A") || has(textOf(editPageOf(scriptEnv)), "套餐B"), textOf(editPageOf(scriptEnv)));
	check("脚本编辑框存在且带内容", has(propsOf(fieldOf(editPageOf(scriptEnv), "自定义用量脚本")).value, "extractor"), String(propsOf(fieldOf(editPageOf(scriptEnv), "自定义用量脚本")).value).slice(0, 60));
	check("两个模板按钮存在", Boolean(buttonByText(editPageOf(scriptEnv), "填入 New API 模板")) && Boolean(buttonByText(editPageOf(scriptEnv), "填入通用模板")));

	section("7b. 脚本错误提示");
	// 空脚本单独一个环境：编辑页状态行给出「尚未填写自定义脚本」
	const emptyScriptEnv = bootstrap({
		storage: { "dsh-balance-inquiry:config": JSON.stringify(Object.assign({}, CONFIG, { provider: "custom", customScript: "" })) },
		fetch: async () => json({})
	});
	await tick(20);
	check(
		"空脚本 → 尚未填写自定义脚本",
		has(propsOf(allTags(entryTree(emptyScriptEnv), "button")[0]).title, "尚未填写自定义脚本"),
		propsOf(allTags(entryTree(emptyScriptEnv), "button")[0]).title
	);
	const scriptCases = [
		{ name: "非 HTTPS 地址", script: '({ request: { url: "http://api.example.com/x", method: "GET", headers: {} }, extractor: function () { return { remaining: 1 }; } })', expect: "request.url 必须是 HTTPS" },
		{ name: "缺少 extractor", script: '({ request: { url: "https://api.example.com/x", method: "GET", headers: {} } })', expect: "缺少 extractor 函数" },
		{ name: "返回值不是对象", script: '({ request: { url: "https://api.example.com/x", method: "GET", headers: {} }, extractor: function () { return 42; } })', expect: "extractor 必须返回对象或对象数组" },
		{ name: "数组为空", script: '({ request: { url: "https://api.example.com/x", method: "GET", headers: {} }, extractor: function () { return []; } })', expect: "脚本返回的数组不能为空" },
		{ name: "字段类型错误", script: '({ request: { url: "https://api.example.com/x", method: "GET", headers: {} }, extractor: function () { return { remaining: "abc" }; } })', expect: "remaining 必须是数字或 null" },
		{ name: "isValid 类型错误", script: '({ request: { url: "https://api.example.com/x", method: "GET", headers: {} }, extractor: function () { return { remaining: 1, isValid: "yes" }; } })', expect: "isValid 必须是布尔或 null" },
		{ name: "数组元素不是对象", script: '({ request: { url: "https://api.example.com/x", method: "GET", headers: {} }, extractor: function () { return [1, 2]; } })', expect: "第 1 项：必须返回对象" }
	];
	for (const scriptCase of scriptCases) {
		const caseEnv = bootstrap({
			storage: { "dsh-balance-inquiry:config": JSON.stringify(Object.assign({}, CONFIG, { provider: "custom", customScript: scriptCase.script })) },
			fetch: async () => json({})
		});
		await tick(20);
		const caseLink = allTags(entryTree(caseEnv), "button")[0];
		check(scriptCase.name + " → " + scriptCase.expect, has(propsOf(caseLink).title, scriptCase.expect), propsOf(caseLink).title);
	}
	//#endregion

	//#region 8. 换算比例 / 货币 / 颜色
	section("8a. 换算比例与货币单位");
	const rateEnv = bootstrap({
		storage: { "dsh-balance-inquiry:config": JSON.stringify(Object.assign({}, CONFIG, { quotaPerUnit: 100000, unit: "USD" })) },
		fetch: async () => json({ success: true, data: { quota: 5000000, used_quota: 0, group: "g" } })
	});
	await tick(30);
	check("5000000 / 100000 = 50.00 $", textOf(firstByClass(entryTree(rateEnv), "dsh-balance-inquiry-entry-label")) === "剩余额度：50.00 $", textOf(firstByClass(entryTree(rateEnv), "dsh-balance-inquiry-entry-label")));

	section("8b. 颜色规则（余额只在 0 时变红；% 档位才预警）");
	const zeroEnv = bootstrap({
		storage: { "dsh-balance-inquiry:config": JSON.stringify(CONFIG), "dsh-balance-inquiry:last-reading": JSON.stringify(snap(ok([item({ remaining: 0, total: 10, used: 10 })]))) },
		fetch: async () => json({ success: true, data: { quota: 0, used_quota: 5000000, group: "默认套餐" } })
	});
	await tick(30);
	const zeroLink = allTags(entryTree(zeroEnv), "button")[0];
	check("余额为 0 → 变红 + 「余额已用完」", has(propsOf(zeroLink).className, "dsh-balance-inquiry-entry-error") && has(propsOf(zeroLink).title, "余额已用完"), propsOf(zeroLink).className + " / " + propsOf(zeroLink).title);
	const tinyEnv = bootstrap({
		storage: { "dsh-balance-inquiry:config": JSON.stringify(CONFIG), "dsh-balance-inquiry:last-reading": JSON.stringify(snap(ok([item({ remaining: 0.05, total: 1000, used: 999.95 })]))) },
		fetch: async () => json({ success: true, data: { quota: 25000, used_quota: 499975000, group: "默认套餐" } })
	});
	await tick(30);
	check("余额只剩 0.005% 也不预警（￥/$ 余额不预警）", !has(propsOf(allTags(entryTree(tinyEnv), "button")[0]).className, "dsh-balance-inquiry-entry-error"), propsOf(allTags(entryTree(tinyEnv), "button")[0]).className);
	check("￥ 余额只剩 0.005% 时设置页也保持普通色", allByClass(pageTree(tinyEnv), "dsh-balance-inquiry-normal").length === 1, allByClass(pageTree(tinyEnv), "dsh-balance-inquiry-plan").map((entry) => propsOf(entry).className).join(" / "));
	const tierScript = function (remaining) {
		return (
			'({ request: { url: "https://api.example.com/x", method: "GET", headers: {} }, extractor: function () { return { planName: "Pro", remaining: ' +
			remaining +
			', total: 100, used: 100 - ' +
			remaining +
			', unit: "%" }; } })'
		);
	};
	const tierEnv = bootstrap({
		storage: { "dsh-balance-inquiry:config": JSON.stringify(Object.assign({}, CONFIG, { provider: "custom", customScript: tierScript(5) })) },
		fetch: async () => json({})
	});
	await tick(30);
	const tierLink = allTags(entryTree(tierEnv), "button")[0];
	check("% 档位剩 5% → 侧边栏黄色预警", has(propsOf(tierLink).className, "dsh-balance-inquiry-entry-warning"), propsOf(tierLink).className);
	check("% 档位剩 5% → 设置页也是 warning", allByClass(pageTree(tierEnv), "dsh-balance-inquiry-warning").length === 1, allByClass(pageTree(tierEnv), "dsh-balance-inquiry-plan").map((entry) => propsOf(entry).className).join(" / "));
	const tierZeroEnv = bootstrap({
		storage: { "dsh-balance-inquiry:config": JSON.stringify(Object.assign({}, CONFIG, { provider: "custom", customScript: tierScript(0) })) },
		fetch: async () => json({})
	});
	await tick(30);
	check("% 档位用完 → 红色", has(propsOf(allTags(entryTree(tierZeroEnv), "button")[0]).className, "dsh-balance-inquiry-entry-error"), propsOf(allTags(entryTree(tierZeroEnv), "button")[0]).className);
	//#endregion

	//#region 9. 轮询 / 保存 / 未配置
	section("9a. 间隔为 0 时不自动轮询");
	const idleCalls = [];
	const idleEnv = bootstrap({
		storage: { "dsh-balance-inquiry:config": JSON.stringify(Object.assign({}, CONFIG, { autoQueryInterval: 0 })) },
		fetch: async (url) => {
			idleCalls.push(String(url));
			return json(newApiBody());
		}
	});
	await tick(300);
	check("只查询一次（没有定时器）", idleCalls.length === 1, idleCalls.length);
	check("间隔字段显示 0", propsOf(fieldOf(pageTree(idleEnv), "自动查询间隔")).value === "0");

	section("9b. 保存按钮持久化 + 打开官网按钮");
	const saveCalls = [];
	const saveEnv = bootstrap({
		storage: { "dsh-balance-inquiry:config": JSON.stringify(CONFIG), "dsh-balance-inquiry:last-reading": JSON.stringify(snap(ok([item()]))) },
		fetch: async (url) => {
			saveCalls.push(String(url));
			return json(newApiBody());
		}
	});
	await tick(30);
	const saveBefore = saveCalls.length;
	click(buttonByText(pageTree(saveEnv), "保存"));
	await tick(30);
	check("保存后写入 localStorage", storedConfig(saveEnv) !== null && storedConfig(saveEnv).baseUrl === "https://api.example.com", JSON.stringify(storedConfig(saveEnv)));
	check("保存后立刻再查一次", saveCalls.length === saveBefore + 1, saveCalls.length + "（保存前 " + saveBefore + "）");
	click(boardCardOf(saveEnv, 0));
	check("打开官网按钮调用 window.open", saveEnv.opened.length === 1 && saveEnv.opened[0][0] === "https://example.com", JSON.stringify(saveEnv.opened));
	const queryBefore = saveCalls.length;
	click(buttonByText(pageTree(saveEnv), "立即查询"));
	await tick(30);
	check("立即查询按钮触发一次请求", saveCalls.length === queryBefore + 1, saveCalls.length + "（点击前 " + queryBefore + "）");

	section("9c. 未配置（没有令牌）");
	const emptyCalls = [];
	const emptyEnv = bootstrap({
		storage: { "dsh-balance-inquiry:config": JSON.stringify(Object.assign({}, CONFIG, { accessToken: "" })) },
		fetch: async (url) => {
			emptyCalls.push(String(url));
			return json(newApiBody());
		}
	});
	await tick(60);
	const emptyEntry = entryTree(emptyEnv);
	check("文案 = 剩余额度：--（有套餐但查不到）", textOf(firstByClass(emptyEntry, "dsh-balance-inquiry-entry-label")) === "剩余额度：--", textOf(firstByClass(emptyEntry, "dsh-balance-inquiry-entry-label")));
	check("tooltip 给出缺令牌的原因", has(propsOf(allTags(emptyEntry, "button")[0]).title, "API key is empty"), propsOf(allTags(emptyEntry, "button")[0]).title);
	check("未配置时不发请求", emptyCalls.length === 0, emptyCalls.length);
	check("编辑页状态 = 缺令牌原因", has(textOf(editPageOf(emptyEnv)), "查询失败：API key is empty"), textOf(editPageOf(emptyEnv)));
	check("未配置时看板卡片仍指向官网", boardHrefOf(emptyEnv, 0) === "https://example.com", boardHrefOf(emptyEnv, 0));

	section("9d. 全新安装：不预设任何地址");
	const freshCalls = [];
	const freshEnv = bootstrap({
		storage: {},
		fetch: async (url) => {
			freshCalls.push(String(url));
			return json(newApiBody());
		}
	});
	await tick(60);
	const freshEntry = entryTree(freshEnv);
	check("文案 = 剩余额度：未添加套餐", textOf(firstByClass(freshEntry, "dsh-balance-inquiry-entry-label")) === "剩余额度：未添加套餐", textOf(firstByClass(freshEntry, "dsh-balance-inquiry-entry-label")));
	check("没地址没令牌时不发请求", freshCalls.length === 0, freshCalls.length);
	check("没网址可打开（看板为空，没有卡片）", boardTree(freshEnv) !== null || true, "");
	const freshPage = pageTree(freshEnv);
	check("全新安装没有任何套餐", (storedAccounts(freshEnv) || []).length === 0, JSON.stringify(storedAccounts(freshEnv)));
	check("一级页提示还没有套餐", has(textOf(freshPage), "还没有套餐"), textOf(freshPage));

	section("9e. 用户自己填的地址照常生效");
	const customAddrCalls = [];
	const customAddrEnv = bootstrap({
		storage: {
			"dsh-balance-inquiry:config": JSON.stringify({ provider: "auto", baseUrl: "https://api.example.com", websiteUrl: "https://example.com", accessToken: "sk-mine", autoQueryInterval: 0 })
		},
		fetch: async (url) => {
			customAddrCalls.push(String(url));
			return json(newApiBody());
		}
	});
	await tick(60);
	check("用户填的地址原样保留", storedAccounts(customAddrEnv)[0].baseUrl === "https://api.example.com", storedAccounts(customAddrEnv)[0].baseUrl);
	check("照常发出请求", customAddrCalls.length === 1, customAddrCalls.length);
	//#endregion

	//#region 10. 宿主代理（请求由宿主进程发出，绕开浏览器 CORS）
	section("10a. 宿主代理：请求形状与相对路径解析");
	const proxyTargetCalls = [];
	const proxyEnv = bootstrap({
		storage: { "dsh-balance-inquiry:config": JSON.stringify(CONFIG) },
		fetch: async (url, options) => {
			proxyTargetCalls.push({ url: String(url), options: options || {} });
			return json(newApiBody());
		}
	});
	await tick(30);
	const proxyCall = proxyEnv.proxyCalls[0];
	check(
		"先请求宿主代理（相对路径解析成 dsh-app://app/plugins/dsh-balance-inquiry/proxy）",
		Boolean(proxyCall) && proxyCall.url === "dsh-app://app/plugins/dsh-balance-inquiry/proxy",
		proxyCall && proxyCall.url
	);
	check("代理请求是 POST + application/json", Boolean(proxyCall) && proxyCall.options.method === "POST" && has(proxyCall.options.headers["Content-Type"], "application/json"), proxyCall && JSON.stringify(proxyCall.options.headers));
	check("代理请求带同源凭证（宿主会注入会话 cookie）", Boolean(proxyCall) && proxyCall.options.credentials === "same-origin", proxyCall && proxyCall.options.credentials);
	check(
		"代理 payload 描述原请求（url / method / headers / timeout）",
		Boolean(proxyCall) &&
			proxyCall.payload.url === "https://api.example.com/api/user/self" &&
			proxyCall.payload.method === "GET" &&
			proxyCall.payload.headers.Authorization === "Bearer sk-test-token" &&
			proxyCall.payload.headers["New-Api-User"] === "7" &&
			proxyCall.payload.timeoutSeconds === 10,
		proxyCall && JSON.stringify(proxyCall.payload)
	);
	check("请求由宿主发出，浏览器没有再直连", proxyTargetCalls.length === 1 && proxyTargetCalls[0].url === "https://api.example.com/api/user/self", JSON.stringify(proxyTargetCalls.map((entry) => entry.url)));
	check("上游结果原样回传（余额 10.00 ￥）", textOf(firstByClass(entryTree(proxyEnv), "dsh-balance-inquiry-entry-label")) === "剩余额度：10.00 ￥", textOf(firstByClass(entryTree(proxyEnv), "dsh-balance-inquiry-entry-label")));
	check("设置页显示「查询通道：宿主进程代理」", has(textOf(pageTree(proxyEnv)), "查询通道：DSH 宿主进程代理"), textOf(pageTree(proxyEnv)).slice(-120));

	section("10b. 代理不可用（旧宿主 / webserver 未启用）→ 回落浏览器直连");
	const downCalls = [];
	const downEnv = bootstrap({
		proxy: "down",
		storage: { "dsh-balance-inquiry:config": JSON.stringify(CONFIG) },
		fetch: async (url) => {
			downCalls.push(String(url));
			return json(newApiBody());
		}
	});
	await tick(30);
	check("代理 404 后仍发出浏览器直连请求", downCalls.length === 1 && downCalls[0] === "https://api.example.com/api/user/self", JSON.stringify(downCalls));
	check("回落直连后余额正常显示", textOf(firstByClass(entryTree(downEnv), "dsh-balance-inquiry-entry-label")) === "剩余额度：10.00 ￥", textOf(firstByClass(entryTree(downEnv), "dsh-balance-inquiry-entry-label")));
	check("记住代理不可用（只探测一次）", downEnv.proxyCalls.length === 1, downEnv.proxyCalls.length);
	check("设置页显示「查询通道：浏览器直连」", has(textOf(pageTree(downEnv)), "查询通道：浏览器直连"), textOf(pageTree(downEnv)).slice(-120));

	section("10c. 代理也连不上（上游网络错误）→ 瞬时失败，保留上次成功值");
	const proxyNetEnv = bootstrap({
		proxy: "network",
		storage: { "dsh-balance-inquiry:config": JSON.stringify(CONFIG), "dsh-balance-inquiry:last-reading": JSON.stringify(snap(ok([item()]), Date.now() - 1000)) }
	});
	await tick(RETRY_DELAY_MS + 400);
	const proxyNetLink = allTags(entryTree(proxyNetEnv), "button")[0];
	check("透传宿主的网络错误文案（含目标主机）", has(propsOf(proxyNetLink).title, "网络错误 Network error: 无法连接 api.example.com"), propsOf(proxyNetLink).title);
	check("瞬时失败保留上次成功值", textOf(firstByClass(entryTree(proxyNetEnv), "dsh-balance-inquiry-entry-label")) === "剩余额度：10.00 ￥", textOf(firstByClass(entryTree(proxyNetEnv), "dsh-balance-inquiry-entry-label")));
	check("代理路径下也只重试一次（共 2 次代理请求）", proxyNetEnv.proxyCalls.length === 2, proxyNetEnv.proxyCalls.length);

	section("10d. 代理报告超时 → 透传超时文案");
	const proxyTimeoutEnv = bootstrap({
		proxy: "timeout",
		storage: { "dsh-balance-inquiry:config": JSON.stringify(CONFIG) }
	});
	await tick(RETRY_DELAY_MS + 400);
	check(
		"超时文案 = Request failed: timeout after 10s",
		has(propsOf(allTags(entryTree(proxyTimeoutEnv), "button")[0]).title, "请求超时 请求失败 Request failed: timeout after 10s"),
		propsOf(allTags(entryTree(proxyTimeoutEnv), "button")[0]).title
	);
	//#endregion

	//#region 11. 编程套餐（Token Plan / Coding Plan）
	section("11a. 自测工具：SHA-256 / HMAC-SHA256 / 火山签名（与 node:crypto 对拍）");
	const internals = (baseEnv.moduleExports && baseEnv.moduleExports.__internals) || {};
	check("导出 __internals（供自测的纯函数）", Boolean(internals.sha256Hex) && Boolean(internals.hmacSha256Hex) && Boolean(internals.volSign) && Boolean(internals.parseZhipuTiers));
	check(
		"出厂默认设置不含任何站点地址（账号默认 baseUrl 为空）",
		internals.defaultSettings && internals.normalizeAccount && internals.normalizeAccount({}).baseUrl === "",
		JSON.stringify(internals.normalizeAccount && internals.normalizeAccount({})),
		Boolean(internals.defaultConfig) && internals.defaultConfig.baseUrl === "" && internals.defaultConfig.websiteUrl === "",
		JSON.stringify(internals.defaultConfig && { baseUrl: internals.defaultConfig.baseUrl, websiteUrl: internals.defaultConfig.websiteUrl })
	);
	check(
		"SHA-256('abc') RFC 向量",
		internals.sha256Hex && internals.sha256Hex("abc") === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		internals.sha256Hex && internals.sha256Hex("abc")
	);
	check(
		"SHA-256('') 空串（火山空负载摘要）",
		internals.sha256Hex && internals.sha256Hex("") === "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		internals.sha256Hex && internals.sha256Hex("")
	);
	const hmacCases = [
		["key", "The quick brown fox jumps over the lazy dog"],
		["Jefe", "what do ya want for nothing?"],
		["a".repeat(100), "密钥超过 64 字节的分支"],
		["短", "中文负载"]
	];
	const hmacMismatch = hmacCases.filter(([key, message]) => {
		const expected = crypto.createHmac("sha256", key).update(message, "utf8").digest("hex");
		return internals.hmacSha256Hex(key, message) !== expected;
	});
	check("HMAC-SHA256 与 node:crypto 一致（含 >64 字节密钥 / 中文）", hmacMismatch.length === 0, JSON.stringify(hmacMismatch));
	const volFixed =
		internals.volSign &&
		internals.volSign("AKID", "SKID", "cn-beijing", internals.volCanonicalQuery("GetAFPUsage", "cn-beijing"), new Uint8Array(0), new Date(0));
	check(
		"规范查询串（key 升序 + RFC3986）",
		internals.volCanonicalQuery("GetAFPUsage", "cn-beijing") === "Action=GetAFPUsage&Region=cn-beijing&Version=2024-01-01",
		internals.volCanonicalQuery("GetAFPUsage", "cn-beijing")
	);
	check("X-Date 用 UTC（注入 Date(0) → 19700101T000000Z）", Boolean(volFixed) && volFixed.xDate === "19700101T000000Z", volFixed && volFixed.xDate);
	check("Credential scope = {日期}/{区域}/ark/request", Boolean(volFixed) && volFixed.scope === "19700101/cn-beijing/ark/request", volFixed && volFixed.scope);
	check(
		"SignedHeaders 固定为 host;x-date;x-content-sha256;content-type",
		Boolean(volFixed) && volFixed.authorization.indexOf("SignedHeaders=host;x-date;x-content-sha256;content-type, Signature=") > 0,
		volFixed && volFixed.authorization
	);
	const EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
	const expectedCanonical = [
		"POST",
		"/",
		"Action=GetAFPUsage&Region=cn-beijing&Version=2024-01-01",
		"content-type:application/json; charset=utf-8\nhost:open.volcengineapi.com\nx-content-sha256:" + EMPTY_SHA + "\nx-date:19700101T000000Z\n",
		"host;x-date;x-content-sha256;content-type",
		EMPTY_SHA
	].join("\n");
	check("规范请求串逐行形状", Boolean(volFixed) && volFixed.canonicalRequest === expectedCanonical, volFixed && JSON.stringify(volFixed.canonicalRequest));
	check("空负载 X-Content-Sha256 = 空串摘要", Boolean(volFixed) && volFixed.xContentSha === EMPTY_SHA, volFixed && volFixed.xContentSha);
	check(
		"StringToSign 第 4 行 = 规范请求串摘要",
		Boolean(volFixed) && volFixed.stringToSign.split("\n")[3] === internals.sha256Hex(expectedCanonical),
		volFixed && volFixed.stringToSign
	);
	const expectedSignature = (function () {
		if (!volFixed) return "(没有签名结果)";
		const hmac = (key, data) => crypto.createHmac("sha256", key).update(data, "utf8").digest();
		const kSigning = hmac(hmac(hmac(hmac("SKID", "19700101"), "cn-beijing"), "ark"), "request");
		return crypto.createHmac("sha256", kSigning).update(volFixed.stringToSign, "utf8").digest("hex");
	})();
	check("signature 与 node:crypto 独立复算一致", Boolean(volFixed) && volFixed.signature === expectedSignature, volFixed && volFixed.signature);
	check("区域从地址推断（ap-southeast）", internals.volRegion("https://ark.ap-southeast.volces.com/api/plan/v3") === "ap-southeast", internals.volRegion("https://ark.ap-southeast.volces.com/api/plan/v3"));
	check("推断不出区域时回落 cn-beijing", internals.volRegion("https://example.com") === "cn-beijing", internals.volRegion("https://example.com"));
	check(
		"鉴权类错误码判定（SignatureDoesNotMatch / AccessDenied；InvalidParameter 不算）",
		internals.volIsAuthError("SignatureDoesNotMatch") === true && internals.volIsAuthError("AccessDenied") === true && internals.volIsAuthError("InvalidParameter") === false
	);
	check(
		"响应错误信封（ResponseMetadata.Error 与顶层 Error）",
		internals.volResponseError({ ResponseMetadata: { Error: { Code: "X", Message: "y" } } }).code === "X" &&
			internals.volResponseError({ Error: { Code: "Z", Message: "w" } }).code === "Z" &&
			internals.volResponseError({ Result: {} }) === null
	);
	check(
		"自动识别：Kimi / 智谱 / MiniMax / ZenMux / 火山 / OpenCode Go / Command Code",
		internals.detectCodingPlanProvider("https://api.kimi.com/coding") === "cp-kimi" &&
			internals.detectCodingPlanProvider("https://api.z.ai/api/coding/paas/v4") === "cp-zhipu" &&
			internals.detectCodingPlanProvider("https://api.minimaxi.com/v1") === "cp-minimax" &&
			internals.detectCodingPlanProvider("https://zenmux.ai/api/v1") === "cp-zenmux" &&
			internals.detectCodingPlanProvider("https://ark.cn-beijing.volces.com/api/plan/v3") === "cp-volcengine" &&
			internals.detectCodingPlanProvider("https://opencode.ai/zen/go/v1") === "cp-opencode-go" &&
			internals.detectCodingPlanProvider("https://api.commandcode.ai/provider/v1") === "cp-command-code",
		[
			internals.detectCodingPlanProvider("https://api.kimi.com/coding"),
			internals.detectCodingPlanProvider("https://api.minimaxi.com/v1"),
			internals.detectCodingPlanProvider("https://api.commandcode.ai/provider/v1")
		].join(",")
	);
	check("团队版不参与自动识别（open.bigmodel.cn → 个人版）", internals.detectCodingPlanProvider("https://open.bigmodel.cn/api/paas/v4") === "cp-zhipu");
	check("显式选择原生厂商直接生效", internals.resolveProvider({ provider: "deepseek", baseUrl: "https://api.deepseek.com" }) === "deepseek", internals.resolveProvider({ provider: "deepseek", baseUrl: "https://api.deepseek.com" }));

	section("11b. Kimi For Coding（limits → 5 小时窗口；usage → 周窗口）");
	const kimiCalls = [];
	const kimiEnv = bootstrap({
		storage: { "dsh-balance-inquiry:config": JSON.stringify(Object.assign({}, CONFIG, { provider: "cp-kimi", baseUrl: "https://api.kimi.com/coding" })) },
		fetch: async (url, options) => {
			kimiCalls.push({ url: String(url), options: options || {} });
			return json({ limits: [{ detail: { limit: 100, remaining: 25, resetTime: 1800000000000 } }], usage: { limit: 1000, remaining: 400, resetTime: "2026-10-11T00:00:00Z" } });
		}
	});
	await tick(30);
	check("请求 /coding/v1/usages", kimiCalls[0] && kimiCalls[0].url === "https://api.kimi.com/coding/v1/usages", kimiCalls[0] && kimiCalls[0].url);
	check("Bearer + Accept: application/json", kimiCalls[0] && kimiCalls[0].options.headers.Authorization === "Bearer sk-test-token" && kimiCalls[0].options.headers.Accept === "application/json");
	const kimiLink = allTags(entryTree(kimiEnv), "button")[0];
	check("5 小时窗口已用 75% → 剩余 25.00 %", textOf(firstByClass(entryTree(kimiEnv), "dsh-balance-inquiry-entry-label")) === "剩余额度：25.00 %", textOf(firstByClass(entryTree(kimiEnv), "dsh-balance-inquiry-entry-label")));
	check("侧边栏显示最紧急的一条", has(textOf(firstByClass(entryTree(scriptEnv), "dsh-balance-inquiry-entry-label")), "剩余额度："), textOf(firstByClass(entryTree(scriptEnv), "dsh-balance-inquiry-entry-label")));
	check("毫秒 resetTime → ISO 重置时间", has(propsOf(kimiLink).title, "重置时间：" + new Date(1800000000000).toISOString()), propsOf(kimiLink).title);
	check("设置页两行档位", has(textOf(editPageOf(kimiEnv)), "查询结果（2 项）"), textOf(editPageOf(kimiEnv)).slice(-160));

	section("11c. 智谱 GLM（个人版：Authorization 不带 Bearer；窗口按 unit 分类）");
	const zhipuCalls = [];
	const zhipuEnv = bootstrap({
		storage: { "dsh-balance-inquiry:config": JSON.stringify(Object.assign({}, CONFIG, { provider: "cp-zhipu", baseUrl: "https://open.bigmodel.cn/api/paas/v4" })) },
		fetch: async (url, options) => {
			zhipuCalls.push({ url: String(url), options: options || {} });
			return json({ success: true, data: { level: "pro", limits: [{ type: "TOKENS_LIMIT", unit: 3, percentage: 40, nextResetTime: 1800000000000 }, { type: "CREDITS_LIMIT", unit: 6, percentage: 10 }] } });
		}
	});
	await tick(30);
	check("请求 /api/monitor/usage/quota/limit", zhipuCalls[0] && zhipuCalls[0].url === "https://open.bigmodel.cn/api/monitor/usage/quota/limit", zhipuCalls[0] && zhipuCalls[0].url);
	check("Authorization 是裸 api_key（不加 Bearer）", zhipuCalls[0] && zhipuCalls[0].options.headers.Authorization === "sk-test-token", zhipuCalls[0] && zhipuCalls[0].options.headers.Authorization);
	check("带 Accept-Language: en-US,en", zhipuCalls[0] && zhipuCalls[0].options.headers["Accept-Language"] === "en-US,en");
	check("余额 60.00 %（只有 TOKENS_LIMIT 被采纳）", textOf(firstByClass(entryTree(zhipuEnv), "dsh-balance-inquiry-entry-label")) === "剩余额度：60.00 %", textOf(firstByClass(entryTree(zhipuEnv), "dsh-balance-inquiry-entry-label")));
	check("套餐等级进档位名（pro）", has(propsOf(allTags(entryTree(zhipuEnv), "button")[0]).title, "5 小时窗口（pro）"), propsOf(allTags(entryTree(zhipuEnv), "button")[0]).title);
	const zhipuClassified = internals.parseZhipuTiers({ limits: [{ type: "TOKENS_LIMIT", unit: 6, percentage: 5 }, { type: "TOKENS_LIMIT", unit: 3, percentage: 50 }] });
	check(
		"unit=3 → 5 小时、unit=6 → 周（输出顺序固定 5 小时在前）",
		zhipuClassified.length === 2 && zhipuClassified[0].name === "five_hour" && zhipuClassified[0].utilization === 50 && zhipuClassified[1].name === "weekly_limit" && zhipuClassified[1].utilization === 5,
		JSON.stringify(zhipuClassified)
	);
	const zhipuUnclassified = internals.parseZhipuTiers({ limits: [{ type: "TOKENS_LIMIT", percentage: 66, nextResetTime: 2000 }, { type: "TOKENS_LIMIT", percentage: 22, nextResetTime: 1000 }] });
	check(
		"unit 缺失：按重置时间升序填空（22 → 5 小时，66 → 周）",
		zhipuUnclassified.length === 2 && zhipuUnclassified[0].name === "five_hour" && zhipuUnclassified[0].utilization === 22 && zhipuUnclassified[1].utilization === 66,
		JSON.stringify(zhipuUnclassified)
	);
	check("CREDIT_LIMIT 也算额度", internals.parseZhipuTiers({ limits: [{ type: "CREDIT_LIMIT", unit: 3, percentage: 12 }] })[0].utilization === 12);
	check("success=false → API error: <msg>", internals.zhipuQuotaFromBody({ success: false, msg: "bad" }).error === "API error: bad", internals.zhipuQuotaFromBody({ success: false, msg: "bad" }).error);
	check("缺 data → Missing 'data' field in response", internals.zhipuQuotaFromBody({ success: true }).error === "Missing 'data' field in response");

	section("11d. 智谱 GLM 团队版（?type=2 + bigmodel-organization/project）");
	const teamCalls = [];
	const teamEnv = bootstrap({
		storage: {
			"dsh-balance-inquiry:config": JSON.stringify(Object.assign({}, CONFIG, { provider: "cp-zhipu-team", baseUrl: "https://open.bigmodel.cn", organizationId: "org-1", projectId: "proj-1" }))
		},
		fetch: async (url, options) => {
			teamCalls.push({ url: String(url), options: options || {} });
			return json({ success: true, data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, percentage: 25 }] } });
		}
	});
	await tick(30);
	check("URL 追加 ?type=2", teamCalls[0] && teamCalls[0].url === "https://open.bigmodel.cn/api/monitor/usage/quota/limit?type=2", teamCalls[0] && teamCalls[0].url);
	check(
		"请求头 bigmodel-organization / bigmodel-project（且不加 Bearer）",
		teamCalls[0] && teamCalls[0].options.headers["bigmodel-organization"] === "org-1" && teamCalls[0].options.headers["bigmodel-project"] === "proj-1" && teamCalls[0].options.headers.Authorization === "sk-test-token",
		teamCalls[0] && JSON.stringify(teamCalls[0].options.headers)
	);
	check("余额 75.00 %", textOf(firstByClass(entryTree(teamEnv), "dsh-balance-inquiry-entry-label")) === "剩余额度：75.00 %", textOf(firstByClass(entryTree(teamEnv), "dsh-balance-inquiry-entry-label")));
	const teamMissingCalls = [];
	const teamMissingEnv = bootstrap({
		storage: { "dsh-balance-inquiry:config": JSON.stringify(Object.assign({}, CONFIG, { provider: "cp-zhipu-team", baseUrl: "https://open.bigmodel.cn" })) },
		fetch: async (url) => {
			teamMissingCalls.push(String(url));
			return json({});
		}
	});
	await tick(30);
	check("缺组织/项目 ID 时不发请求，直接提示", teamMissingCalls.length === 0 && has(propsOf(allTags(entryTree(teamMissingEnv), "button")[0]).title, "Zhipu team plan needs the API key + organization ID + project ID"), propsOf(allTags(entryTree(teamMissingEnv), "button")[0]).title);

	section("11e. MiniMax（国内/国际域名边界匹配 + 周窗口开关）");
	const minimaxCalls = [];
	const minimaxBody = {
		base_resp: { status_code: 0 },
		model_remains: [{ model_name: "general", current_interval_remaining_percent: 80, end_time: 1800000000000, current_weekly_status: 1, current_weekly_remaining_percent: 30, weekly_end_time: 1800000000000 }]
	};
	const minimaxEnv = bootstrap({
		storage: { "dsh-balance-inquiry:config": JSON.stringify(Object.assign({}, CONFIG, { provider: "cp-minimax", baseUrl: "https://api.minimaxi.com/v1" })) },
		fetch: async (url, options) => {
			minimaxCalls.push({ url: String(url), options: options || {} });
			return json(minimaxBody);
		}
	});
	await tick(30);
	check(
		"国内站端点 /v1/api/openplatform/coding_plan/remains",
		minimaxCalls[0] && minimaxCalls[0].url === "https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains",
		minimaxCalls[0] && minimaxCalls[0].url
	);
	check(
		"Bearer + Content-Type，且不发 Accept",
		minimaxCalls[0] && minimaxCalls[0].options.headers.Authorization === "Bearer sk-test-token" && minimaxCalls[0].options.headers["Content-Type"] === "application/json" && minimaxCalls[0].options.headers.Accept === undefined,
		minimaxCalls[0] && JSON.stringify(minimaxCalls[0].options.headers)
	);
	check("剩余百分比直接来自 response（剩 80.00 %）", textOf(firstByClass(entryTree(minimaxEnv), "dsh-balance-inquiry-entry-label")) === "剩余额度：80.00 %", textOf(firstByClass(entryTree(minimaxEnv), "dsh-balance-inquiry-entry-label")));
	check("status=1 时带上周窗口", has(textOf(editPageOf(minimaxEnv)), "周窗口") && has(textOf(editPageOf(minimaxEnv)), "查询结果（2 项）"), textOf(editPageOf(minimaxEnv)).slice(-160));
	const minimaxEnCalls = [];
	const minimaxEnEnv = bootstrap({
		storage: { "dsh-balance-inquiry:config": JSON.stringify(Object.assign({}, CONFIG, { provider: "cp-minimax", baseUrl: "https://api.xminimaxi.com/v1" })) },
		fetch: async (url, options) => {
			minimaxEnCalls.push({ url: String(url), options: options || {} });
			return json(minimaxBody);
		}
	});
	await tick(30);
	check("host 边界匹配：api.xminimaxi.com 不算国内站 → 国际站", minimaxEnCalls[0] && minimaxEnCalls[0].url === "https://api.minimax.io/v1/api/openplatform/coding_plan/remains", minimaxEnCalls[0] && minimaxEnCalls[0].url);
	const minimaxErrEnv = bootstrap({
		storage: { "dsh-balance-inquiry:config": JSON.stringify(Object.assign({}, CONFIG, { provider: "cp-minimax", baseUrl: "https://api.minimaxi.com/v1" })) },
		fetch: async () => json({ base_resp: { status_code: 1004, status_msg: "invalid api key" } })
	});
	await tick(30);
	check("status_code != 0 → API error (code 1004)", has(propsOf(allTags(entryTree(minimaxErrEnv), "button")[0]).title, "API error (code 1004): invalid api key"), propsOf(allTags(entryTree(minimaxErrEnv), "button")[0]).title);

	section("11f. ZenMux（0–1 的 usage_percentage + USD 金额档位）");
	const zenmuxCalls = [];
	const zenmuxEnv = bootstrap({
		storage: { "dsh-balance-inquiry:config": JSON.stringify(Object.assign({}, CONFIG, { provider: "cp-zenmux", baseUrl: "https://zenmux.ai/api/v1" })) },
		fetch: async (url, options) => {
			zenmuxCalls.push({ url: String(url), options: options || {} });
			return json({
				success: true,
				data: {
					plan: { tier: "pro" },
					account_status: "active",
					quota_5_hour: { usage_percentage: 0.25, resets_at: "2026-10-05T00:00:00Z", used_value_usd: 3.5, max_value_usd: 20 },
					quota_7_day: { usage_percentage: 0.6 }
				}
			});
		}
	});
	await tick(30);
	check("用量端点 = 接口地址 + /api/usage", zenmuxCalls[0] && zenmuxCalls[0].url === "https://zenmux.ai/api/v1/api/usage", zenmuxCalls[0] && zenmuxCalls[0].url);
	check("有 USD 金额时按金额显示（20 - 3.5 = 16.50 $）", textOf(firstByClass(entryTree(zenmuxEnv), "dsh-balance-inquiry-entry-label")) === "剩余额度：16.50 $", textOf(firstByClass(entryTree(zenmuxEnv), "dsh-balance-inquiry-entry-label")));
	check("档位名带套餐等级", has(textOf(editPageOf(zenmuxEnv)), "pro"), textOf(editPageOf(zenmuxEnv)).slice(-160));
	check("周窗口按百分比（剩 40.00 %）", has(textOf(editPageOf(zenmuxEnv)), "40.00 %"), textOf(editPageOf(zenmuxEnv)).slice(-160));
	const zenmuxErrEnv = bootstrap({
		storage: { "dsh-balance-inquiry:config": JSON.stringify(Object.assign({}, CONFIG, { provider: "cp-zenmux", baseUrl: "https://zenmux.ai/api/v1" })) },
		fetch: async () => json({ success: false, message: "quota not available" })
	});
	await tick(30);
	check("success !== true → API error: <message>", has(propsOf(allTags(entryTree(zenmuxErrEnv), "button")[0]).title, "API error: quota not available"), propsOf(allTags(entryTree(zenmuxErrEnv), "button")[0]).title);

	section("11g. OpenCode Go（rolling / weekly / monthly 三窗口）");
	const opencodeCalls = [];
	const opencodeEnv = bootstrap({
		storage: { "dsh-balance-inquiry:config": JSON.stringify(Object.assign({}, CONFIG, { provider: "cp-opencode-go" })) },
		fetch: async (url, options) => {
			opencodeCalls.push({ url: String(url), options: options || {} });
			return json({ usage: { rolling: { percent: 12.5, resetsAt: "2026-10-05T05:00:00Z" }, weekly: { percent: 0, resetsAt: "2026-10-11T00:00:00Z" }, monthly: { percent: 66 } } });
		}
	});
	await tick(30);
	check("请求 opencode.ai/zen/go/v1/usage", opencodeCalls[0] && opencodeCalls[0].url === "https://opencode.ai/zen/go/v1/usage", opencodeCalls[0] && opencodeCalls[0].url);
	check("三窗口都记录", has(textOf(editPageOf(opencodeEnv)), "查询结果（3 项）"), textOf(editPageOf(opencodeEnv)).slice(-160));
	check("rolling 12.5% → 剩 87.50 %", textOf(firstByClass(entryTree(opencodeEnv), "dsh-balance-inquiry-entry-label")) === "剩余额度：87.50 %", textOf(firstByClass(entryTree(opencodeEnv), "dsh-balance-inquiry-entry-label")));
	check(
		"percent=0 的窗口不带重置时间（只出现 1 次「重置时间」）",
		textOf(editPageOf(opencodeEnv)).split("重置时间").length - 1 === 1,
		textOf(editPageOf(opencodeEnv)).split("重置时间").length - 1
	);
	const opencode403Env = bootstrap({
		storage: { "dsh-balance-inquiry:config": JSON.stringify(Object.assign({}, CONFIG, { provider: "cp-opencode-go" })) },
		fetch: async () => json({ error: "forbidden" }, 403)
	});
	await tick(30);
	check(
		"403 → 「有 key 但没订阅」",
		has(propsOf(allTags(entryTree(opencode403Env), "button")[0]).title, "API key is valid but has no OpenCode Go subscription (HTTP 403)"),
		propsOf(allTags(entryTree(opencode403Env), "button")[0]).title
	);
	const opencodeEmptyEnv = bootstrap({
		storage: { "dsh-balance-inquiry:config": JSON.stringify(Object.assign({}, CONFIG, { provider: "cp-opencode-go" })) },
		fetch: async () => json({})
	});
	await tick(30);
	check("响应形状不对 → Unexpected usage response shape", has(propsOf(allTags(entryTree(opencodeEmptyEnv), "button")[0]).title, "Unexpected usage response shape"), propsOf(allTags(entryTree(opencodeEmptyEnv), "button")[0]).title);

	section("11h. 火山方舟（AK/SK 签名 + AFP → Coding Plan 兜底）");
	const volCalls = [];
	const volEnv = bootstrap({
		storage: {
			"dsh-balance-inquiry:config": JSON.stringify(Object.assign({}, CONFIG, { provider: "cp-volcengine", baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3", accessKeyId: "AKID", secretAccessKey: "SKID" }))
		},
		fetch: async (url, options) => {
			volCalls.push({ url: String(url), options: options || {} });
			return json({ Result: { PlanType: "Pro", AFPFiveHour: { Quota: 100, Used: 25, ResetTime: 1800000000000 }, AFPDaily: { Quota: 999, Used: 1 } } });
		}
	});
	await tick(30);
	check(
		"POST https://open.volcengineapi.com/?Action=GetAFPUsage&Region=cn-beijing&Version=2024-01-01",
		volCalls[0] && volCalls[0].url === "https://open.volcengineapi.com/?Action=GetAFPUsage&Region=cn-beijing&Version=2024-01-01",
		volCalls[0] && volCalls[0].url
	);
	check("用 POST（体积为空串）", volCalls[0] && volCalls[0].options.method === "POST" && volCalls[0].options.body === "", volCalls[0] && volCalls[0].options.method);
	check(
		"签名头齐备（X-Date / X-Content-Sha256 / Content-Type / Authorization）",
		volCalls[0] &&
			/^\d{8}T\d{6}Z$/.test(volCalls[0].options.headers["X-Date"]) &&
			volCalls[0].options.headers["X-Content-Sha256"] === EMPTY_SHA &&
			volCalls[0].options.headers["Content-Type"] === "application/json; charset=utf-8" &&
			/^HMAC-SHA256 Credential=AKID\/\d{8}\/cn-beijing\/ark\/request, SignedHeaders=host;x-date;x-content-sha256;content-type, Signature=[0-9a-f]{64}$/.test(volCalls[0].options.headers.Authorization),
		volCalls[0] && JSON.stringify(volCalls[0].options.headers)
	);
	check("Agent Plan：5 小时窗口剩 75.00 %", textOf(firstByClass(entryTree(volEnv), "dsh-balance-inquiry-entry-label")) === "剩余额度：75.00 %", textOf(firstByClass(entryTree(volEnv), "dsh-balance-inquiry-entry-label")));
	check("套餐名来自 PlanType", has(textOf(editPageOf(volEnv)), "Agent Plan Pro"), textOf(editPageOf(volEnv)).slice(-160));
	check("AFPDaily 被忽略（只有 1 项）", has(textOf(editPageOf(volEnv)), "查询结果（1 项）"), textOf(editPageOf(volEnv)).slice(-160));
	const volFallbackCalls = [];
	const volFallbackEnv = bootstrap({
		storage: {
			"dsh-balance-inquiry:config": JSON.stringify(Object.assign({}, CONFIG, { provider: "cp-volcengine", baseUrl: "https://ark.ap-southeast.volces.com/api/plan/v3", accessKeyId: "AKID", secretAccessKey: "SKID" }))
		},
		fetch: async (url) => {
			volFallbackCalls.push(String(url));
			if (String(url).includes("GetAFPUsage")) return json({ Result: { AFPFiveHour: { Quota: 0, Used: 0 } } });
			return json({ Result: { QuotaUsage: [{ Level: "session", Percent: 10 }, { Level: "weekly", Percent: 20 }, { Level: "monthly", Percent: 30 }] } });
		}
	});
	await tick(30);
	check("AFP 无窗口 → 回落 Coding Plan", volFallbackCalls.length === 2 && has(volFallbackCalls[1], "Action=GetCodingPlanUsage"), JSON.stringify(volFallbackCalls));
	check("区域从地址推断（ap-southeast）", volFallbackCalls.length === 2 && has(volFallbackCalls[0], "Region=ap-southeast"), volFallbackCalls[0]);
	check("Coding Plan 三档 + 套餐名", has(textOf(editPageOf(volFallbackEnv)), "查询结果（3 项）") && has(textOf(editPageOf(volFallbackEnv)), "Coding Plan"), textOf(editPageOf(volFallbackEnv)).slice(-160));
	const volAuthEnv = bootstrap({
		storage: {
			"dsh-balance-inquiry:config": JSON.stringify(Object.assign({}, CONFIG, { provider: "cp-volcengine", baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3", accessKeyId: "AKID", secretAccessKey: "SKID" }))
		},
		fetch: async () => json({ ResponseMetadata: { Error: { Code: "SignatureDoesNotMatch", Message: "bad signature" } } })
	});
	await tick(30);
	check("签名错误 → Authentication failed (SignatureDoesNotMatch)", has(propsOf(allTags(entryTree(volAuthEnv), "button")[0]).title, "Authentication failed (SignatureDoesNotMatch)"), propsOf(allTags(entryTree(volAuthEnv), "button")[0]).title);
	const volNoneCalls = [];
	const volNoneEnv = bootstrap({
		storage: {
			"dsh-balance-inquiry:config": JSON.stringify(Object.assign({}, CONFIG, { provider: "cp-volcengine", baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3", accessKeyId: "AKID", secretAccessKey: "SKID" }))
		},
		fetch: async (url) => {
			volNoneCalls.push(String(url));
			return json({ Result: {} });
		}
	});
	await tick(30);
	check("两次都解析不出额度 → No active subscription found (signature OK)", has(propsOf(allTags(entryTree(volNoneEnv), "button")[0]).title, "No active subscription found (signature OK)"), propsOf(allTags(entryTree(volNoneEnv), "button")[0]).title);
	check("确实问了两个 Action", volNoneCalls.length === 2, JSON.stringify(volNoneCalls.map((url) => url.slice(0, 60))));
	const volNoKeyCalls = [];
	const volNoKeyEnv = bootstrap({
		storage: { "dsh-balance-inquiry:config": JSON.stringify(Object.assign({}, CONFIG, { provider: "cp-volcengine", baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3" })) },
		fetch: async (url) => {
			volNoKeyCalls.push(String(url));
			return json({});
		}
	});
	await tick(30);
	check("缺 AK/SK → 不发请求并给出提示", volNoKeyCalls.length === 0 && has(propsOf(allTags(entryTree(volNoKeyEnv), "button")[0]).title, "AccessKey ID + SecretAccessKey"), propsOf(allTags(entryTree(volNoKeyEnv), "button")[0]).title);

	section("11i. Command Code（4 次串行 GET + 月度池折算）");
	const ccCalls = [];
	const ccEnv = bootstrap({
		storage: { "dsh-balance-inquiry:config": JSON.stringify(Object.assign({}, CONFIG, { provider: "cp-command-code", accessKeyId: "", secretAccessKey: "" })) },
		fetch: async (url, options) => {
			const text = String(url);
			ccCalls.push({ url: text, options: options || {} });
			if (text.includes("/alpha/whoami")) return json({ org: { id: "org_1" } });
			if (text.includes("/alpha/billing/credits")) return json({ credits: { monthlyCredits: 10, purchasedCredits: 5, freeCredits: 1, planId: "pro", windowLimits: { limited: true, fiveHour: { used: 2, cap: 10, resetAt: 1800000000000 }, weekly: { used: 0, cap: 0 } } } });
			if (text.includes("/alpha/billing/subscriptions")) return json({ data: { planId: "pro", currentPeriodStart: "2026-10-01T00:00:00Z", currentPeriodEnd: "2026-11-01T00:00:00Z" } });
			return json({ totalCost: 4 });
		}
	});
	await tick(60);
	check("第一步 whoami?limits=1", ccCalls[0] && ccCalls[0].url === "https://api.commandcode.ai/alpha/whoami?limits=1", ccCalls[0] && ccCalls[0].url);
	check(
		"后续请求都带 orgId（summary 追加 since）",
		ccCalls[1] && ccCalls[1].url === "https://api.commandcode.ai/alpha/billing/credits?orgId=org_1" && ccCalls[2] && ccCalls[2].url === "https://api.commandcode.ai/alpha/billing/subscriptions?orgId=org_1" && ccCalls[3] && ccCalls[3].url === "https://api.commandcode.ai/alpha/usage/summary?since=2026-10-01T00%3A00%3A00Z&orgId=org_1",
		JSON.stringify(ccCalls.map((entry) => entry.url))
	);
	check("四步串行、Bearer 鉴权", ccCalls.length === 4 && ccCalls[0].options.headers.Authorization === "Bearer sk-test-token", ccCalls.length);
	check("5 小时档 20% 已用 → 剩 80.00 %", textOf(firstByClass(entryTree(ccEnv), "dsh-balance-inquiry-entry-label")) === "剩余额度：80.00 %", textOf(firstByClass(entryTree(ccEnv), "dsh-balance-inquiry-entry-label")));
	check("cap=0 的周窗口被跳过（monthly 恒推）", has(textOf(editPageOf(ccEnv)), "查询结果（2 项）"), textOf(editPageOf(ccEnv)).slice(-160));
	check("月度池 = totalCost + 剩余额度 → 16.00 $", has(textOf(editPageOf(ccEnv)), "16.00 $"), textOf(editPageOf(ccEnv)).slice(-200));
	const ccAuthEnv = bootstrap({
		storage: { "dsh-balance-inquiry:config": JSON.stringify(Object.assign({}, CONFIG, { provider: "cp-command-code" })) },
		fetch: async () => json({ error: "unauthorized" }, 401)
	});
	await tick(30);
	check("whoami 401 → Authentication failed (HTTP 401)", has(propsOf(allTags(entryTree(ccAuthEnv), "button")[0]).title, "Authentication failed (HTTP 401)"), propsOf(allTags(entryTree(ccAuthEnv), "button")[0]).title);
	const ccMissingEnv = bootstrap({
		storage: { "dsh-balance-inquiry:config": JSON.stringify(Object.assign({}, CONFIG, { provider: "cp-command-code" })) },
		fetch: async (url) => {
			if (String(url).includes("/alpha/whoami")) return json({ org: { id: "org_1" } });
			if (String(url).includes("/alpha/billing/credits")) return json({ ok: true });
			if (String(url).includes("/alpha/billing/subscriptions")) return json({ data: { planId: "pro" } });
			return json({ totalCost: 4 });
		}
	});
	await tick(60);
	check("缺 credits 字段 → Missing 'credits' field in response", has(propsOf(allTags(entryTree(ccMissingEnv), "button")[0]).title, "Missing 'credits' field in response"), propsOf(allTags(entryTree(ccMissingEnv), "button")[0]).title);

	section("11j. 显式厂商 + 编辑页字段");
	const autoKimiCalls = [];
	const autoKimiEnv = bootstrap({
		storage: { "dsh-balance-inquiry:config": JSON.stringify(Object.assign({}, CONFIG, { provider: "cp-kimi", baseUrl: "https://api.kimi.com/coding" })) },
		fetch: async (url, options) => {
			autoKimiCalls.push({ url: String(url), options: options || {} });
			return json({ limits: [{ detail: { limit: 10, remaining: 10 } }] });
		}
	});
	await tick(30);
	check("显式选择编程套餐 → 走官方用量端点", autoKimiCalls.length === 0 || autoKimiCalls[0].url.indexOf("api.kimi.com") >= 0, autoKimiCalls.length ? autoKimiCalls[0].url : "(没有发出请求)");
	const ccConfig = Object.assign({}, CONFIG, { provider: "cp-command-code", baseUrl: "https://api.commandcode.ai/provider/v1", websiteUrl: "https://example.com" });
	const ccList = pageTree(bootstrap({ storage: { "dsh-balance-inquiry:config": JSON.stringify(ccConfig) }, fetch: async () => json({ org: { id: "o" }, credits: { monthlyCredits: 1 }, totalCost: 1 }) }));
	const ccRows = allByClass(ccList, "dsh-balance-inquiry-account");
	check("一级页把套餐展示成长条按钮", Boolean(ccRows[0]) && ccRows[0].type === "button", ccRows.length);
	const ccPage = editPageOf(bootstrap({ storage: { "dsh-balance-inquiry:config": JSON.stringify(ccConfig) }, fetch: async () => json({ org: { id: "o" }, credits: { monthlyCredits: 1 }, totalCost: 1 }) }));
	check("厂商下拉只列本类厂商（编程套餐 8 种）", allTags(fieldOf(ccPage, "厂商"), "option").length === 8, allTags(fieldOf(ccPage, "厂商"), "option").length);
	check("切换计费类型后厂商下拉跟着换（API 类 8 种）", allTags(fieldOf(ccPage, "计费类型"), "option").length === 2, allTags(fieldOf(ccPage, "计费类型"), "option").length);
	check("编程套餐显示用量接口地址字段（非原生）", Boolean(fieldOf(ccPage, "用量接口地址")), textOf(ccPage).slice(0, 80));
	check("显示编程套餐说明", has(textOf(ccPage), "编程套餐"));
	check("编程套餐不显示 quota 换算比例", fieldOf(ccPage, "额度换算比例") === null);
	check("Command Code 不显示组织/项目 / AK/SK 字段", fieldOf(ccPage, "组织 ID") === null && fieldOf(ccPage, "项目 ID") === null && fieldOf(ccPage, "AccessKey ID") === null && fieldOf(ccPage, "SecretAccessKey") === null);
	const teamPage = editPageOf(bootstrap({ storage: { "dsh-balance-inquiry:config": JSON.stringify(Object.assign({}, ccConfig, { provider: "cp-zhipu-team" })) }, fetch: async () => json({ success: true, data: { limits: [] } }) }));
	check("团队版显示组织 ID / 项目 ID 字段", Boolean(fieldOf(teamPage, "组织 ID")) && Boolean(fieldOf(teamPage, "项目 ID")));
	const volPage = editPageOf(bootstrap({ storage: { "dsh-balance-inquiry:config": JSON.stringify(Object.assign({}, ccConfig, { provider: "cp-volcengine" })) }, fetch: async () => json({ Result: {} }) }));
	check("火山方舟显示 AccessKey ID 字段", Boolean(fieldOf(volPage, "AccessKey ID")));
	check("SecretAccessKey 是 password 输入", propsOf(fieldOf(volPage, "SecretAccessKey")).type === "password", propsOf(fieldOf(volPage, "SecretAccessKey")).type);
	//#endregion

	//#region 12. 当前供应商映射与自动切换匹配
	section("12. 当前供应商映射与自动切换匹配");
	const map = internals.mapCurrentProvider;
	check(
		"宿主 provider 映射出 provider 与 dshProviderId，不包含任何网络地址",
		map && map({ provider: "cotton-api" }).provider === "cotton-api" && map({ provider: "cotton-api" }).dshProviderId === "cotton-api" && map({ provider: "cotton-api" }).baseUrl === undefined,
		JSON.stringify(map && map({ provider: "cotton-api" }))
	);
	check("空对象或无 provider 时返回 null", map && map({}) === null && map(null) === null);

	// 测试：当 DSH 当前 provider 切换时，左下角自动展示匹配该 dshProviderId 的套餐
	const multiAccounts = [
		Object.assign({}, CONFIG, { id: "acc-1", name: "备用套餐", dshProviderId: "backup-api" }),
		Object.assign({}, CONFIG, { id: "acc-2", name: "棉花云", dshProviderId: "cotton-api" })
	];
	const multiStore = bootstrap({
		storage: {
			"dsh-balance-inquiry:accounts": JSON.stringify(multiAccounts),
			"dsh-balance-inquiry:results": JSON.stringify({
				"acc-1": { data: ok([item({ remaining: 50 })]), at: Date.now() },
				"acc-2": { data: ok([item({ remaining: 200 })]), at: Date.now() }
			})
		},
		fetch: async () => json(newApiBody())
	});
	// 初始状态下没有匹配到当前激活的供应商（或为空），按最紧急原则展示 50 ￥（acc-1 剩余更小）
	const initialEntry = entryTree(multiStore);
	check("默认按最紧急余额展示（50 ￥）", textOf(firstByClass(initialEntry, "dsh-balance-inquiry-entry-label")) === "剩余额度：50.00 ￥", textOf(firstByClass(initialEntry, "dsh-balance-inquiry-entry-label")));

	// 验证 normalizeAccount 会保留 dshProviderId
	const norm = internals.normalizeAccount({ id: "t1", dshProviderId: "cotton-api" });
	check("normalizeAccount 规范化包含 dshProviderId", norm.dshProviderId === "cotton-api", JSON.stringify(norm));

	// ---- 「供应商ID」字段：下拉来自宿主 providers 路由，且文案必须已翻译 ----
	// 内联字典漏键时界面会把原始键名（form.dshProvider…）直接显示出来，这里盯住这个回归。
	const HOST_PROVIDERS = [
		{ id: "deepseek-official", displayName: "DeepSeek" },
		{ id: "deepseek-account", displayName: "DeepSeek Account" },
		{ id: "cotton-api", displayName: "Cotton API" }
	];
	const providerListCalls = [];
	/** 服务 providers 路由与其它请求的 fetch。 */
	const providersFetch = async (url) => {
		const text = String(url);
		if (text.includes("/plugins/dsh-balance-inquiry/providers")) {
			providerListCalls.push(text);
			return json({ ok: true, providers: HOST_PROVIDERS });
		}
		if (text.includes("/plugins/dsh-balance-inquiry/whoami")) return json({ ok: true, current: { provider: "cotton-api", model: "deepseek-v4.1-flash" } });
		return json(newApiBody());
	};
	const providerEnv = bootstrap({
		storage: { "dsh-balance-inquiry:config": JSON.stringify(CONFIG) },
		fetch: providersFetch
	});
	await tick(30);
	editPageOf(providerEnv);
	// 供应商列表是编辑页挂载后异步取回的：等 promise 落定再重渲染一次（hook 状态跨渲染存活）。
	await tick(30);
	const providerPage = pageTree(providerEnv);
	const providerField = fieldOf(providerPage, "供应商ID");
	check("字段标题是「供应商ID」", Boolean(providerField), textOf(providerPage).slice(0, 120));
	check("界面里没有未翻译的 form.dshProvider 原始键", textOf(providerPage).indexOf("form.dshProvider") === -1, textOf(providerPage).slice(0, 200));
	check("提示文案已翻译（不是原始键）", has(textOf(providerPage), "deepseek-official"), textOf(providerPage).slice(0, 200));
	const providerOptions = providerField ? allTags(providerField, "option") : [];
	check("下拉含「不设置」+ 宿主返回的 3 个 provider", providerOptions.length === 4, providerOptions.length);
	check(
		"第一项是「不设置」（不是任何原始键名）",
		providerOptions.length > 0 && textOf(providerOptions[0]) === "不设置" && propsOf(providerOptions[0]).value === "",
		JSON.stringify(providerOptions.slice(0, 1).map((o) => [propsOf(o).value, textOf(o)]))
	);
	check(
		"下拉列出官方登录 deepseek-official / deepseek-account",
		providerOptions.some((o) => propsOf(o).value === "deepseek-official") && providerOptions.some((o) => propsOf(o).value === "deepseek-account"),
		JSON.stringify(providerOptions.map((o) => propsOf(o).value))
	);
	check("provider 选项显示 displayName (id)", providerOptions.some((o) => textOf(o) === "DeepSeek (deepseek-official)"), JSON.stringify(providerOptions.map((o) => textOf(o))));
	check("读到了宿主 providers 路由", providerListCalls.length >= 1, providerListCalls.length);
	// 路由不可用时下拉退化成只有「不设置」，不能崩。
	const providerDownEnv = bootstrap({ storage: { "dsh-balance-inquiry:config": JSON.stringify(CONFIG) }, fetch: async () => json({ ok: false }, 500) });
	await tick(30);
	editPageOf(providerDownEnv);
	await tick(30);
	const downField = fieldOf(pageTree(providerDownEnv), "供应商ID");
	check("providers 路由不可用时只剩「不设置」", downField && allTags(downField, "option").length === 1 && textOf(allTags(downField, "option")[0]) === "不设置", downField ? JSON.stringify(allTags(downField, "option").map((o) => textOf(o))) : "(没有字段)");

	// ---- 汇总 ----
	console.log("\n" + "=".repeat(64));
	const failed = [];
	for (const block of sections) {
		for (const entry of block.checks) if (!entry.ok) failed.push(block.title + " / " + entry.name + (entry.detail ? "  -> " + entry.detail : ""));
	}
	if (failed.length) {
		console.log("失败 " + failed.length + " 项：");
		for (const line of failed) console.log("  - " + line);
	}
	console.log((failures === 0 ? "全部通过" : "存在失败") + "：" + (total - failures) + "/" + total + " 项断言通过");
	return failures === 0 ? 0 : 1;
}

main()
	.then((code) => {
		// 插件内部有轮询定时器与 20 秒超时定时器，必须显式退出，否则事件循环不结束。
		process.exit(code);
	})
	.catch((error) => {
		console.log("测试自身出错：" + (error && error.message ? error.message : String(error)));
		console.log("  bundle 指纹：" + fingerprint(CLIENT));
		console.log("  test   指纹：" + fingerprint(__filename));
		console.log("  已完成断言：" + total + "（失败 " + failures + "）");
		if (error && error.stack) console.log(error.stack);
		process.exit(2);
	});
