/**
 * dsh-balance-inquiry —— 宿主侧的一半：一个受约束的本机 HTTP 代理路由。
 *
 * 浏览器（渲染进程）发跨域请求要过 CORS：目标站点的响应里没有
 * `Access-Control-Allow-Origin` 时，Chromium 会把响应丢掉，`fetch` 抛出
 * TypeError，表现就是「无法连接」。为了让插件能查这类地址，这里把请求交给
 * 宿主进程（Node，无 CORS），再通过 dsh-host-webserver 暴露成一条路由：
 *
 *     POST /plugins/dsh-balance-inquiry/proxy        （同源请求，不经网络）
 *     { url, method, headers, body, timeoutSeconds }
 *     → { ok: true, status, statusText, body }
 *     → { ok: false, error: { kind: "network" | "timeout" | "invalid", message } }
 *
 * 桌面端里 `dsh-app://app/plugins/...` 会被 main.js 的 protocol.handle 原样转发给
 * 宿主 webserver（并注入鉴权 cookie），所以渲染进程用相对路径 fetch 即可，
 * 同源请求既不需要 CORS 也不会有混合内容问题。Web 版同理。
 *
 * 安全边界：两条路由都只服务本机（webserver 只监听 127.0.0.1，且要求请求带会话 cookie）。
 * 代理路由还拒绝非 HTTPS 目标（`http://` 只允许 localhost / 127.0.0.1 / ::1）、带用户名密码的 URL、
 * 内网 / 回环（除 localhost）/ 链路本地 IP 字面量 —— 它不能被当作扫描内网的跳板。
 *
 *     GET  /plugins/dsh-balance-inquiry/whoami       （只读当前激活的 provider id 与 model，不含任何地址与密钥）
 *     GET  /plugins/dsh-balance-inquiry/providers    （只读已配置的 provider id 列表，供套餐绑定，不含任何地址与密钥）
 *     → { ok: true, current: { provider, model } }
 *     → { ok: true, providers: [{ id, displayName }] }
 *
 * 配置文件的存放（这一对路由让「配置」不再只活在浏览器 localStorage 里）：
 *
 *     GET  /plugins/dsh-balance-inquiry/config       → { ok: true, dir, present, settings, accounts, results, errors }
 *     POST /plugins/dsh-balance-inquiry/config       ← { settings?, accounts?, results? }
 *     → { ok: true, dir, written: ["settings", …] }
 *
 * 目录固定为 `$DSH_HOME/dsh-balance-inquiry/`；没有设置 DSH_HOME 时退回
 * `~/.dsh/dsh-balance-inquiry/`。目录里只有两个 YAML 文件，没有别的：
 *
 *     config.yml        设置、套餐（不含密钥）与最近读数
 *     credentials.yml   每个套餐的密钥，按套餐 id 分组
 *
 * 密钥单独成文件，是为了让 config.yml 可以安全地分享 / 提交到版本库。
 * 写入一律走「临时文件 + rename」，避免掉电 / 崩溃时留下半个文件。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "./yaml.js";

export const name = "dsh-balance-inquiry";

/** 依赖宿主 webserver；没有它就不激活（客户端会退回浏览器直连）。 */
export const inject = ["webServer"];

const PROXY_PATH = "/plugins/dsh-balance-inquiry/proxy";
const WHOAMI_PATH = "/plugins/dsh-balance-inquiry/whoami";
const PROVIDERS_PATH = "/plugins/dsh-balance-inquiry/providers";
const CONFIG_PATH = "/plugins/dsh-balance-inquiry/config";
const CONFIG_DIR_NAME = "dsh-balance-inquiry";
/** 目录里只允许这两个文件。 */
const CONFIG_FILE = "config.yml";
const CREDENTIALS_FILE = "credentials.yml";
/** 存进 credentials.yml 的字段：都是「拿到就能用你的额度」的密钥。 */
const SECRET_FIELDS = ["accessToken", "secretAccessKey", "accessKeyId", "organizationId", "projectId", "userId"];
const MAX_REQUEST_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_SECONDS = 10;
const MIN_TIMEOUT_SECONDS = 2;
const MAX_TIMEOUT_SECONDS = 30;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

function clampSeconds(value) {
	const number = Number(value);
	if (!Number.isFinite(number)) return DEFAULT_TIMEOUT_SECONDS;
	return Math.min(MAX_TIMEOUT_SECONDS, Math.max(MIN_TIMEOUT_SECONDS, Math.round(number)));
}

/** 内网 / 回环 / 链路本地 IP 字面量（域名交由上面的 https 规则约束）。 */
function isPrivateAddress(hostname) {
	const host = String(hostname || "").toLowerCase();
	if (host.startsWith("[") && host.endsWith("]")) return isPrivateAddress(host.slice(1, -1));
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
		const parts = host.split(".").map(Number);
		if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
		const [a, b] = parts;
		if (a === 10 || a === 127 || a === 0) return true;
		if (a === 169 && b === 254) return true;
		if (a === 172 && b >= 16 && b <= 31) return true;
		if (a === 192 && b === 168) return true;
		if (a === 100 && b >= 64 && b <= 127) return true;
		return false;
	}
	if (host.includes(":")) {
		// IPv6 字面量：只放行 global unicast（2000::/3），其余（fc00::/7、fe80::/10、::1）拒绝。
		return !/^2[0-9a-f]{3}:/.test(host) && !/^3[0-9a-f]{3}:/.test(host);
	}
	return false;
}

/** 校验目标地址；不合法就抛出给调用方的错误文案。 */
function resolveTarget(raw) {
	let url;
	try {
		url = new URL(String(raw || ""));
	} catch (error) {
		throw new Error("目标地址不是合法的 URL");
	}
	if (url.username || url.password) throw new Error("目标地址里不能带用户名或密码");
	const loopback = LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
	if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
		throw new Error("只允许 HTTPS 目标（本机地址可以用 HTTP）");
	}
	if (!loopback && isPrivateAddress(url.hostname)) throw new Error("目标地址不能是内网 / 回环地址");
	return url;
}

function sendJson(response, status, value) {
	const body = JSON.stringify(value);
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"content-length": String(Buffer.byteLength(body))
	});
	response.end(body);
}

function readJsonBody(request) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		request.on("data", (chunk) => {
			size += chunk.length;
			if (size > MAX_REQUEST_BYTES) {
				reject(new Error("请求体过大"));
				request.destroy?.();
				return;
			}
			chunks.push(chunk);
		});
		request.on("error", (error) => reject(error));
		request.on("end", () => {
			const text = Buffer.concat(chunks).toString("utf8").trim();
			if (!text) {
				resolve({});
				return;
			}
			try {
				resolve(JSON.parse(text));
			} catch (error) {
				reject(new Error("请求体不是合法 JSON"));
			}
		});
	});
}

/** 在宿主进程里发请求（没有 CORS）。 */
async function proxyFetch(payload) {
	const url = resolveTarget(payload.url);
	const seconds = clampSeconds(payload.timeoutSeconds);
	const method = String(payload.method || "GET").toUpperCase();
	if (!/^[A-Z]+$/.test(method)) {
		return { ok: false, error: { kind: "invalid", message: `不支持的请求方法 '${method}'` } };
	}
	const headers = { accept: "application/json" };
	const source = payload.headers && typeof payload.headers === "object" ? payload.headers : {};
	for (const [key, value] of Object.entries(source)) {
		if (value === undefined || value === null) continue;
		const name = String(key).toLowerCase();
		if (name === "host" || name === "content-length" || name === "connection") continue;
		headers[name] = String(value);
	}
	const body = method === "GET" || method === "HEAD" ? undefined : payload.body === undefined || payload.body === null ? undefined : String(payload.body);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), seconds * 1000);
	try {
		const response = await fetch(url, { method: method, headers: headers, body: body, redirect: "follow", cache: "no-store", signal: controller.signal });
		let text = "";
		try {
			text = await response.text();
		} catch (error) {
			return { ok: false, error: { kind: "network", message: "读取响应失败 Failed to read response: " + String((error && error.message) || error) } };
		}
		return { ok: true, status: response.status, statusText: response.statusText, body: text };
	} catch (error) {
		if (error && error.name === "AbortError") {
			return { ok: false, error: { kind: "timeout", message: "请求超时 请求失败 Request failed: timeout after " + seconds + "s" } };
		}
		return { ok: false, error: { kind: "network", message: "网络错误 Network error: 无法连接 " + url.host + "（" + String((error && error.message) || error) + "）" } };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * 读当前会话默认使用的模型供应商 ID 与模型名称。
 * 只返回 provider 和 model 字符串，不提取任何 baseURL、apiKey 等敏感字段。
 */
function describeCurrentProvider(ctx) {
	const model = ctx.get("agentDefaultModel");
	const selection = model && typeof model.currentSelection === "function" ? model.currentSelection() : null;
	if (!selection || !selection.provider) return null;
	return { provider: selection.provider, model: selection.model || "" };
}

/**
 * 读可绑定的 provider 列表（仅 id 与 displayName），供前端下拉选择绑定。
 *
 * 两个来源，缺一不可：
 *  1. `llm.listConfigurableProviders()` —— 每个可配置适配器注册的目录。
 *     内置的官方路由就在这儿：`deepseek-official`（API Key 登录）与
 *     `deepseek-account`（账号登录）。它们的 `settingsPath` 是空数组，
 *     配置在各自条目里而不是 `config.providers` 映射中，所以在设置文档里
 *     根本看不到 —— 只扫设置文档就会漏掉官方供应商。
 *  2. 设置文档里的 `providers` 映射 —— `llm-pi-ai` 的自定义路由（New API 等）。
 *     作为兜底，覆盖目录里还没登记或已下线的配置。
 *
 * 不返回任何 baseURL 或密钥字段。
 */
function listConfiguredProviders(ctx) {
	const result = [];
	const seen = new Set();
	const push = (id, displayName) => {
		if (typeof id !== "string" || id.length === 0 || seen.has(id)) return;
		seen.add(id);
		result.push({ id: id, displayName: typeof displayName === "string" && displayName.length > 0 ? displayName : id });
	};

	// 1) 严格读取当前 profile 用户的 cordis.patch.yml 里已配置的供应商：
	//    只扫描 settings 里各个插件在 config.providers 下真正声明/存在的供应商路由
	//    （例如 llm-pi-ai.config.providers 下的 cotton-api 等）。
	const settings = ctx.get("settings");
	if (settings && typeof settings.describe === "function") {
		try {
			for (const descriptor of settings.describe()) {
				const value = descriptor && descriptor.value;
				const providers = value && value.providers;
				if (!providers || typeof providers !== "object") continue;
				for (const [id, entry] of Object.entries(providers)) {
					push(id, entry && typeof entry === "object" ? entry.displayName : undefined);
				}
			}
		} catch (error) {
			// 忽略解析错误
		}
	}

	// 2) 官方供应商支持：将官方登录方式统一合并为 deepseek-official（DeepSeek 官方）
	const llm = ctx.get("llm");
	if (llm && typeof llm.listConfigurableProviders === "function") {
		try {
			for (const entry of llm.listConfigurableProviders()) {
				if (!entry) continue;
				// 将 deepseek-official / deepseek-account 合并为单一选项 deepseek-official
				if (entry.provider === "deepseek-official" || entry.provider === "deepseek-account") {
					push("deepseek-official", "DeepSeek 官方");
				}
			}
		} catch (error) {
			// 忽略
		}
	}

	return result;
}

/** 处理函数：只接受本机、且带会话 cookie 的调用。 */
async function handleProxy(request, response) {
	const method = String(request.method || "GET").toUpperCase();
	if (method === "OPTIONS") {
		response.writeHead(204, { "access-control-allow-origin": "dsh-app://app", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, OPTIONS" });
		response.end();
		return;
	}
	if (method === "GET") {
		sendJson(response, 200, { ok: true, proxy: "dsh-balance-inquiry", path: PROXY_PATH });
		return;
	}
	if (method !== "POST") {
		sendJson(response, 405, { ok: false, error: { kind: "invalid", message: "只支持 GET / POST" } });
		return;
	}
	// 桌面端由 main.js 注入宿主 cookie；Web 版是浏览器自己的会话 cookie。
	// 没有 cookie 的裸调用（例如本机其他进程）一律拒绝，避免这条路由变成开放代理。
	const cookie = request.headers && request.headers.cookie;
	if (!cookie) {
		sendJson(response, 403, { ok: false, error: { kind: "invalid", message: "缺少会话 cookie，拒绝代理" } });
		return;
	}
	let payload;
	try {
		payload = await readJsonBody(request);
	} catch (error) {
		sendJson(response, 400, { ok: false, error: { kind: "invalid", message: String((error && error.message) || error) } });
		return;
	}
	let result;
	try {
		result = await proxyFetch(payload);
	} catch (error) {
		sendJson(response, 200, { ok: false, error: { kind: "invalid", message: String((error && error.message) || error) } });
		return;
	}
	sendJson(response, 200, result);
}

/* ------------------------------------------------------------------ 配置落盘 */

/** 配置文件目录：`$DSH_HOME/dsh-balance-inquiry/`，没有 DSH_HOME 时退回 `~/.dsh/…`。 */
function resolveConfigDir() {
	const raw = process.env.DSH_HOME;
	let base = typeof raw === "string" ? raw.trim() : "";
	if (!base) base = join(homedir(), ".dsh");
	else if (base === "~") base = homedir();
	else if (base.startsWith("~/") || base.startsWith("~\\")) base = join(homedir(), base.slice(2));
	if (!isAbsolute(base)) base = join(process.cwd(), base);
	return join(base, CONFIG_DIR_NAME);
}

function configFilePath(dir, fileName) {
	return join(dir, fileName);
}

/** 把值写成一个 YAML 文件（原子写：先写 `.tmp`，再 rename 覆盖）。 */
function writeYamlFile(dir, fileName, value) {
	const file = configFilePath(dir, fileName);
	const tmp = `${file}.tmp`;
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(tmp, stringifyYaml(value), "utf8");
	try {
		renameSync(tmp, file);
	} catch (error) {
		try {
			unlinkSync(tmp);
		} catch (cleanupError) {
			// 忽略清理失败
		}
		throw error;
	}
	return file;
}

/** 读一个 YAML 文件；不存在 → null 且 present=false；解析失败 → 记进 errors 并退回 null。 */
function readYamlFile(dir, fileName, errors) {
	const file = configFilePath(dir, fileName);
	if (!existsSync(file)) return { present: false, value: null };
	try {
		const text = readFileSync(file, "utf8");
		const value = parseYaml(text);
		return { present: true, value: value === null || value === undefined ? {} : value };
	} catch (error) {
		if (Array.isArray(errors)) errors.push({ file: fileName, path: file, message: String((error && error.message) || error) });
		return { present: false, value: null };
	}
}

function asObject(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/**
 * 把套餐拆成「可公开」与「密钥」两份。
 *
 * config.yml 里存套餐的非密钥字段；credentials.yml 里按套餐 id 分组存密钥。
 * 这样 config.yml 可以放心分享，credentials.yml 单独收好即可。
 */
function splitAccounts(accounts) {
	const publicList = [];
	const secrets = {};
	for (const account of accounts) {
		if (!account || typeof account !== "object") continue;
		const publicEntry = {};
		const secretEntry = {};
		for (const [key, value] of Object.entries(account)) {
			if (SECRET_FIELDS.includes(key)) {
				if (value !== undefined && value !== null && String(value) !== "") secretEntry[key] = value;
			} else {
				publicEntry[key] = value;
			}
		}
		publicList.push(publicEntry);
		const id = String(publicEntry.id || "");
		if (id && Object.keys(secretEntry).length) secrets[id] = secretEntry;
	}
	return { accounts: publicList, credentials: secrets };
}

/** 把密钥合回套餐（config.yml 里没有的密钥字段从 credentials.yml 补上）。 */
function mergeAccounts(accounts, credentials) {
	const list = Array.isArray(accounts) ? accounts : [];
	const secrets = asObject(credentials);
	return list.map((account) => {
		const merged = Object.assign({}, account);
		const id = String(merged.id || "");
		const secret = id && secrets[id] && typeof secrets[id] === "object" ? secrets[id] : null;
		if (secret) {
			for (const key of SECRET_FIELDS) {
				if (merged[key] === undefined || merged[key] === null || merged[key] === "") {
					if (secret[key] !== undefined) merged[key] = secret[key];
				}
			}
		}
		return merged;
	});
}

/**
 * 读配置：config.yml + credentials.yml，合成前端要的形状。
 * 返回里额外带 `present` 告诉客户端文件是否已经存在（用于首次迁移）。
 */
function readConfig(dir) {
	const errors = [];
	const configRead = readYamlFile(dir, CONFIG_FILE, errors);
	const credentialsRead = readYamlFile(dir, CREDENTIALS_FILE, errors);
	const config = asObject(configRead.value);
	const credentials = asObject(credentialsRead.value);
	const settings = asObject(config.settings);
	const results = asObject(config.results);
	const accounts = mergeAccounts(config.accounts, credentials);
	return {
		dir: dir,
		files: { config: CONFIG_FILE, credentials: CREDENTIALS_FILE },
		present: {
			settings: configRead.present && Object.prototype.hasOwnProperty.call(config, "settings"),
			accounts: configRead.present && Object.prototype.hasOwnProperty.call(config, "accounts"),
			results: configRead.present && Object.prototype.hasOwnProperty.call(config, "results")
		},
		settings: settings,
		accounts: accounts,
		results: results,
		errors: errors
	};
}

/**
 * 写配置：只处理请求体里出现的分片，其余保持原样。
 * 传空对象 / 空数组也算显式写入（用于清空），未传才是「不动」。
 *
 * 注意 settings / results / accounts 都在 config.yml 里，所以任何一次写入都会
 * 重写整个 config.yml —— 先把文件里已有的内容读出来，再把本次改动的分片盖上去。
 */
function writeConfig(dir, body) {
	const source = body && typeof body === "object" ? body : {};
	const written = [];
	const has = (key) => Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined && source[key] !== null;
	const touched = ["settings", "accounts", "results"].filter(has);
	if (!touched.length) return { dir: dir, written: written };

	// 先读出磁盘上现有的内容，避免局部写入把别的分片冲掉。
	const errors = [];
	const configRead = readYamlFile(dir, CONFIG_FILE, errors);
	const credentialsRead = readYamlFile(dir, CREDENTIALS_FILE, errors);
	const config = asObject(configRead.value);
	let credentials = asObject(credentialsRead.value);

	if (has("settings")) {
		const settings = source.settings;
		if (typeof settings !== "object" || Array.isArray(settings)) throw new Error("settings 必须是对象");
		config.settings = settings;
		written.push("settings");
	}
	if (has("results")) {
		const results = source.results;
		if (typeof results !== "object" || Array.isArray(results)) throw new Error("results 必须是对象");
		config.results = results;
		written.push("results");
	}
	if (has("accounts")) {
		const accounts = source.accounts;
		if (!Array.isArray(accounts)) throw new Error("accounts 必须是数组");
		const split = splitAccounts(accounts);
		config.accounts = split.accounts;
		// 密钥整份重写：套餐删掉后它的密钥也要一起消失。
		credentials = split.credentials;
		written.push("accounts");
		// 没有密钥时不留下一个空的 credentials.yml。
		if (Object.keys(credentials).length) writeYamlFile(dir, CREDENTIALS_FILE, credentials);
		else {
			const stale = configFilePath(dir, CREDENTIALS_FILE);
			if (existsSync(stale)) {
				try {
					unlinkSync(stale);
				} catch (error) {
					// 忽略删除失败
				}
			}
		}
	}

	writeYamlFile(dir, CONFIG_FILE, config);
	return { dir: dir, written: written };
}

/**
 * 迁移旧版本留下的 JSON 分片（settings.json / accounts.json / results.json）。
 *
 * 只在 config.yml 还不存在时执行一次：把三个 JSON 读出来合成一份 YAML，
 * 然后删掉旧文件——目录里最终只会有 config.yml 与 credentials.yml。
 * 旧文件缺失或坏掉都只是跳过，不影响启动。
 */
function migrateLegacyJson(dir) {
	if (existsSync(configFilePath(dir, CONFIG_FILE))) return null;
	const readJson = (name) => {
		const file = join(dir, name);
		if (!existsSync(file)) return undefined;
		try {
			const text = readFileSync(file, "utf8").trim();
			return text ? JSON.parse(text) : undefined;
		} catch (error) {
			return undefined;
		}
	};
	const settings = readJson("settings.json");
	const accounts = readJson("accounts.json");
	const results = readJson("results.json");
	if (settings === undefined && accounts === undefined && results === undefined) return null;
	const body = {};
	if (settings !== undefined) body.settings = settings;
	if (accounts !== undefined) body.accounts = accounts;
	if (results !== undefined) body.results = results;
	let result;
	try {
		result = writeConfig(dir, body);
	} catch (error) {
		return null;
	}
	for (const name of ["settings.json", "accounts.json", "results.json"]) {
		const file = join(dir, name);
		if (!existsSync(file)) continue;
		try {
			unlinkSync(file);
		} catch (error) {
			// 忽略删除失败
		}
	}
	return result;
}

/** 配置路由：读写都要求会话 cookie，避免同机其他进程顺手改配置。 */
async function handleConfig(request, response) {
	const method = String(request.method || "GET").toUpperCase();
	// 预检不带 cookie（浏览器就是这么发的），必须先于鉴权放行。
	if (method === "OPTIONS") {
		response.writeHead(204, { "access-control-allow-origin": "dsh-app://app", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, OPTIONS" });
		response.end();
		return;
	}
	const cookie = request.headers && request.headers.cookie;
	if (!cookie) {
		sendJson(response, 403, { ok: false, error: { kind: "invalid", message: "缺少会话 cookie，拒绝访问配置" } });
		return;
	}
	let dir;
	try {
		dir = resolveConfigDir();
	} catch (error) {
		sendJson(response, 500, { ok: false, error: { kind: "invalid", message: String((error && error.message) || error) } });
		return;
	}
	// 老版本用的是三个 JSON 分片，读之前先把它们并成 YAML（只会发生一次）。
	if (method === "GET") {
		try {
			migrateLegacyJson(dir);
		} catch (error) {
			// 迁移失败不影响读取：下面照常读 YAML（可能还是空的）。
		}
	}
	if (method === "GET") {
		sendJson(response, 200, { ok: true, ...readConfig(dir) });
		return;
	}
	if (method !== "POST") {
		sendJson(response, 405, { ok: false, error: { kind: "invalid", message: "只支持 GET / POST" } });
		return;
	}
	let body;
	try {
		body = await readJsonBody(request);
	} catch (error) {
		sendJson(response, 400, { ok: false, error: { kind: "invalid", message: String((error && error.message) || error) } });
		return;
	}
	try {
		const result = writeConfig(dir, body);
		sendJson(response, 200, { ok: true, dir: result.dir, written: result.written });
	} catch (error) {
		sendJson(response, 400, { ok: false, error: { kind: "invalid", message: String((error && error.message) || error) } });
	}
}

export function apply(ctx) {
	const disposeProxy = ctx.webServer.register({ path: PROXY_PATH, kind: "exact", handler: handleProxy });
	ctx.effect(() => disposeProxy, "dsh-balance-inquiry: host proxy route");
	const disposeWhoami = ctx.webServer.register({
		path: WHOAMI_PATH,
		kind: "exact",
		handler: (request, response) => {
			const cookie = request.headers && request.headers.cookie;
			if (!cookie) {
				sendJson(response, 403, { ok: false, error: { kind: "invalid", message: "缺少会话 cookie，拒绝访问" } });
				return;
			}
			let current = null;
			try {
				current = describeCurrentProvider(ctx);
			} catch (error) {
				current = null;
			}
			if (!current) {
				sendJson(response, 200, { ok: false, error: { kind: "unavailable", message: "读不到当前模型供应商" } });
				return;
			}
			sendJson(response, 200, { ok: true, current: current });
		}
	});
	ctx.effect(() => disposeWhoami, "dsh-balance-inquiry: whoami route");

	const disposeProviders = ctx.webServer.register({
		path: PROVIDERS_PATH,
		kind: "exact",
		handler: (request, response) => {
			const cookie = request.headers && request.headers.cookie;
			if (!cookie) {
				sendJson(response, 403, { ok: false, error: { kind: "invalid", message: "缺少会话 cookie，拒绝访问" } });
				return;
			}
			let list = [];
			try {
				list = listConfiguredProviders(ctx);
			} catch (error) {
				list = [];
			}
			sendJson(response, 200, { ok: true, providers: list });
		}
	});
	ctx.effect(() => disposeProviders, "dsh-balance-inquiry: providers route");

	const disposeConfig = ctx.webServer.register({ path: CONFIG_PATH, kind: "exact", handler: handleConfig });
	ctx.effect(() => disposeConfig, "dsh-balance-inquiry: config route");
}

/** 供自测引用的内部实现。 */
export const __internals = {
	listConfiguredProviders: listConfiguredProviders,
	describeCurrentProvider: describeCurrentProvider,
	resolveConfigDir: resolveConfigDir,
	readConfig: readConfig,
	writeConfig: writeConfig,
	handleConfig: handleConfig,
	splitAccounts: splitAccounts,
	mergeAccounts: mergeAccounts,
	migrateLegacyJson: migrateLegacyJson,
	secretFields: SECRET_FIELDS,
	configFile: CONFIG_FILE,
	credentialsFile: CREDENTIALS_FILE,
	configPath: CONFIG_PATH
};
