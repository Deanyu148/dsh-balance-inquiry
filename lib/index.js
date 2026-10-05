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
 * 安全边界：该路由只服务本机（webserver 只监听 127.0.0.1，且要求请求带会话 cookie），
 * 并拒绝非 HTTPS 目标（`http://` 只允许 localhost / 127.0.0.1 / ::1）、带用户名密码的 URL、
 * 内网 / 回环（除 localhost）/ 链路本地 IP 字面量 —— 它不能被当作扫描内网的跳板。
 */
export const name = "dsh-balance-inquiry";

/** 依赖宿主 webserver；没有它就不激活（客户端会退回浏览器直连）。 */
export const inject = ["webServer"];

const PROXY_PATH = "/plugins/dsh-balance-inquiry/proxy";
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

export function apply(ctx) {
	const dispose = ctx.webServer.register({ path: PROXY_PATH, kind: "exact", handler: handleProxy });
	ctx.effect(() => dispose, "dsh-balance-inquiry: host proxy route");
}
