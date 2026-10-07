#!/usr/bin/env node
/**
 * dsh-balance-inquiry 宿主半边（lib/index.js）的冒烟测试。
 *
 * 请求由宿主进程（Node，无 CORS）发出。测试自己起一个**不返回任何
 * Access-Control-Allow-Origin 头**的本机 HTTP 服务当作「被 CORS 拦住的目标站」，
 * 然后确认：
 *   - 宿主代理能读到它的响应（浏览器里这会直接 TypeError）；
 *   - 路由只接受带会话 cookie 的本机调用；
 *   - 非 HTTPS（非本机）、带用户名密码、内网地址一律拒绝；
 *   - 上游连不上 / 超时分别回 kind=network / kind=timeout，且超时被夹到 [2,30] 秒。
 *
 * 用法：node tools/balance-host-proxy-test.cjs [-v]
 */
"use strict";

const http = require("node:http");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const HOST_HALF = path.resolve(__dirname, "..", "lib", "index.js");
const PROXY_PATH = "/plugins/dsh-balance-inquiry/proxy";
const WHOAMI_PATH = "/plugins/dsh-balance-inquiry/whoami";
const PROVIDERS_PATH = "/plugins/dsh-balance-inquiry/providers";

const verbose = process.argv.indexOf("-v") !== -1 || process.argv.indexOf("--verbose") !== -1;

let total = 0;
let failures = 0;
let current = null;

function section(title) {
	current = title;
	console.log("\n" + title);
}

function check(name, condition, detail) {
	total += 1;
	const ok = Boolean(condition);
	if (!ok) {
		failures += 1;
		console.log("  x " + name + (detail === undefined ? "" : "  -> " + String(detail)));
	} else if (verbose) {
		console.log("  v " + name);
	}
}

/** 假的 IncomingMessage：先让 handler 注册监听，再按 setImmediate 吐数据。 */
function makeReq(method, headers, body) {
	const handlers = {};
	const chunks = [];
	if (body !== undefined && body !== null) chunks.push(Buffer.from(String(body), "utf8"));
	const req = {
		method: method,
		headers: headers || {},
		on(event, fn) {
			(handlers[event] = handlers[event] || []).push(fn);
			return req;
		},
		destroy() {},
		emit(event, arg) {
			for (const fn of handlers[event] || []) fn(arg);
		}
	};
	setImmediate(() => {
		for (const chunk of chunks) req.emit("data", chunk);
		req.emit("end");
	});
	return req;
}

/** 假的 ServerResponse。 */
function makeRes() {
	return {
		statusCode: 0,
		headers: {},
		body: "",
		writeHead(status, headers) {
			this.statusCode = status;
			this.headers = headers || {};
		},
		end(text) {
			this.body = text === undefined || text === null ? "" : String(text);
		}
	};
}

function jsonOf(response) {
	try {
		return JSON.parse(response.body);
	} catch (error) {
		return null;
	}
}

/** 起一个不回 CORS 头、但能正常返回 New API 余额的本机服务。 */
function startTargetServer() {
	const server = http.createServer((req, res) => {
		if (req.url === "/echo") {
			// 把收到的请求头原样回显：用于验证「浏览器禁止设置的头」经宿主代理也能生效。
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ headers: req.headers }));
			return;
		}
		if (req.url === "/slow") {
			// 故意不响应，用来验证宿主侧的超时（2 秒后由 AbortController 中止）。
			setTimeout(() => {
				try {
					res.writeHead(200, { "content-type": "application/json" });
					res.end('{"success":true}');
				} catch (error) {
					/* 连接已被中止 */
				}
			}, 5000);
			return;
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ success: true, data: { quota: 5000000, used_quota: 1000000, group: "默认套餐" } }));
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => resolve(server));
	});
}

async function call(handler, method, headers, body) {
	const response = makeRes();
	await handler(makeReq(method, headers, body), response);
	return response;
}

async function main() {
	console.log("dsh-balance-inquiry 宿主代理测试（" + process.version + " · " + process.platform + "）");
	console.log("  宿主半边：" + HOST_HALF);

	const server = await startTargetServer();
	const port = server.address().port;
	const targetUrl = "http://127.0.0.1:" + port + "/api/user/self";
	const rules = {
		badUrl: JSON.stringify({ url: "not a url" }),
		httpRemote: JSON.stringify({ url: "http://example.com/api/user/self" }),
		privateIp: JSON.stringify({ url: "https://10.0.0.1/api/user/self" }),
		withCreds: JSON.stringify({ url: "https://user:pass@example.com/api/user/self" }),
		refused: JSON.stringify({ url: "https://127.0.0.1:1/api/user/self" }),
		slow: JSON.stringify({ url: "http://127.0.0.1:" + port + "/slow", timeoutSeconds: 1 }),
		ok: JSON.stringify({ url: targetUrl, method: "GET", headers: { Authorization: "Bearer sk-test", "New-Api-User": "7" } })
	};

	const module = await import(pathToFileURL(HOST_HALF).href);
	const routes = [];
	const effects = [];
	/** 假的宿主服务表：whoami 路由通过 ctx.get() 读它。 */
	const services = {
		agentDefaultModel: {
			currentSelection() {
				return { provider: "cotton-api", model: "deepseek-v4.1-flash" };
			}
		},
		settings: {
			describe() {
				return [
					{
						ns: "llm-pi-ai",
						value: { providers: { "cotton-api": { displayName: "Cotton API", baseURL: "https://api.cottonapi.cloud/v1", api: "openai-completions" } } }
					}
				];
			}
		}
	};
	const ctx = {
		webServer: {
			register(route) {
				routes.push(route);
				return () => {};
			}
		},
		effect(fn, label) {
			effects.push(label);
			const disposer = fn();
			return typeof disposer === "function" ? disposer : () => {};
		},
		/** 只读服务访问器：whoami 路由用它读当前模型供应商。 */
		get(name) {
			return services[name];
		}
	};

	section("1. 宿主半边形状");
	check("name = dsh-balance-inquiry", module.name === "dsh-balance-inquiry", module.name);
	check("inject = ['webServer']", Array.isArray(module.inject) && module.inject.join(",") === "webServer", JSON.stringify(module.inject));
	check("apply 是函数", typeof module.apply === "function");
	module.apply(ctx);
	const proxyRoute = routes.find((route) => route.path === PROXY_PATH);
	const whoamiRoute = routes.find((route) => route.path === WHOAMI_PATH);
	const providersRoute = routes.find((route) => route.path === PROVIDERS_PATH);
	check("注册了代理、whoami、providers 三条 exact 路由", routes.length === 3 && Boolean(proxyRoute) && Boolean(whoamiRoute) && Boolean(providersRoute) && proxyRoute.kind === "exact" && whoamiRoute.kind === "exact" && providersRoute.kind === "exact", JSON.stringify(routes.map((route) => route.kind + " " + route.path)));
	check("注册了三条清理 effect", effects.length === 3, JSON.stringify(effects));
	const handler = proxyRoute.handler;
	check("handler 是函数", typeof handler === "function");

	section("2. 能力探测 / 方法限制");
	const probe = await call(handler, "GET", {});
	check("GET → 200 + {ok:true,proxy:'dsh-balance-inquiry'}", probe.statusCode === 200 && jsonOf(probe).ok === true && jsonOf(probe).proxy === "dsh-balance-inquiry", probe.statusCode + " " + probe.body);
	const options = await call(handler, "OPTIONS", {});
	check("OPTIONS → 204", options.statusCode === 204, options.statusCode);
	const put = await call(handler, "PUT", { cookie: "dsh=1" }, "{}");
	check("PUT → 405", put.statusCode === 405, put.statusCode);

	section("3. 只服务带会话 cookie 的本机调用");
	const noCookie = await call(handler, "POST", {}, rules.ok);
	check("没有 cookie → 403（不变成开放代理）", noCookie.statusCode === 403, noCookie.statusCode + " " + noCookie.body);
	const badJson = await call(handler, "POST", { cookie: "dsh=1" }, "{oops");
	check("请求体不是 JSON → 400", badJson.statusCode === 400, badJson.statusCode + " " + badJson.body);

	section("4. 目标地址白名单");
	const cases = [
		["非 URL", rules.badUrl],
		["远程 http", rules.httpRemote],
		["内网 IP", rules.privateIp],
		["带用户名密码", rules.withCreds]
	];
	for (const [label, payload] of cases) {
		const response = await call(handler, "POST", { cookie: "dsh=1" }, payload);
		const body = jsonOf(response);
		check(label + " → ok:false / kind=invalid", response.statusCode === 200 && body && body.ok === false && body.error.kind === "invalid", response.statusCode + " " + response.body);
	}

	section("5. 真的能读到「没有 CORS 头」的目标站（浏览器在这里会失败）");
	const success = await call(handler, "POST", { cookie: "dsh=1" }, rules.ok);
	const successBody = jsonOf(success);
	check("ok:true + 上游状态 200", successBody && successBody.ok === true && successBody.status === 200, success.statusCode + " " + success.body);
	check(
		"回传的 body 是 New API 余额 JSON",
		successBody && typeof successBody.body === "string" && successBody.body.includes('"quota":5000000') && successBody.body.includes('"success":true'),
		successBody && String(successBody.body).slice(0, 120)
	);
	check("Authorization 头被转发（本机服务不校验，仅确认不丢头）", successBody && successBody.ok === true);

	section("5b. 浏览器禁止设置的头，经宿主代理也能生效");
	const echoRules = JSON.stringify({
		url: "http://127.0.0.1:" + port + "/echo",
		method: "GET",
		headers: { "User-Agent": "dsh-balance-inquiry-test/1.0", "X-Test": "1", Authorization: "Bearer sk-test" }
	});
	const echo = await call(handler, "POST", { cookie: "dsh=1" }, echoRules);
	const echoBody = jsonOf(echo);
	const echoed = echoBody && echoBody.ok === true ? JSON.parse(echoBody.body).headers : {};
	check("User-Agent 原样到达目标站（浏览器里会被忽略）", echoed["user-agent"] === "dsh-balance-inquiry-test/1.0", JSON.stringify(echoed["user-agent"]));
	check("自定义头与 Authorization 都到达", echoed["x-test"] === "1" && echoed.authorization === "Bearer sk-test", JSON.stringify(echoed));

	section("6. 上游失败语义");
	const refused = await call(handler, "POST", { cookie: "dsh=1" }, rules.refused);
	const refusedBody = jsonOf(refused);
	check("连接被拒 → ok:false / kind=network + 文案含主机", refusedBody && refusedBody.ok === false && refusedBody.error.kind === "network" && refusedBody.error.message.includes("127.0.0.1:1"), refused.body);
	const slow = await call(handler, "POST", { cookie: "dsh=1" }, rules.slow);
	const slowBody = jsonOf(slow);
	check(
		"超时 → kind=timeout，且 timeoutSeconds 被夹到最小 2 秒",
		slowBody && slowBody.ok === false && slowBody.error.kind === "timeout" && slowBody.error.message.includes("timeout after 2s"),
		slow.body
	);

	server.close();
	server.unref();

	section("7. whoami：读出当前模型供应商（供客户端匹配与自动切换）");
	const whoami = await call(whoamiRoute.handler, "GET", { cookie: "dsh=1" }, "");
	const whoamiBody = jsonOf(whoami);
	check("whoami 返回 ok", whoamiBody && whoamiBody.ok === true, whoami.body);
	check(
		"只带出 provider 与 model，不泄露 baseUrl 或其它网络地址",
		whoamiBody && whoamiBody.current && whoamiBody.current.provider === "cotton-api" && whoamiBody.current.model === "deepseek-v4.1-flash" && whoamiBody.current.baseUrl === undefined,
		JSON.stringify(whoamiBody && whoamiBody.current)
	);
	check("不泄露密钥字段", whoamiBody && JSON.stringify(whoamiBody).indexOf("apiKey") === -1 && JSON.stringify(whoamiBody).indexOf("sk-") === -1, whoami.body);
	const whoamiNoCookie = await call(whoamiRoute.handler, "GET", {}, "");
	const whoamiNoCookieBody = jsonOf(whoamiNoCookie);
	check("没有会话 cookie 一律拒绝 whoami", whoamiNoCookieBody && whoamiNoCookieBody.ok === false, whoamiNoCookie.body);

	// 读不到服务时给出 ok:false，而不是抛错
	const savedModel = services.agentDefaultModel;
	services.agentDefaultModel = undefined;
	const whoamiEmpty = await call(whoamiRoute.handler, "GET", { cookie: "dsh=1" }, "");
	const whoamiEmptyBody = jsonOf(whoamiEmpty);
	check("读不到供应商时 ok:false + 说明", whoamiEmptyBody && whoamiEmptyBody.ok === false && Boolean(whoamiEmptyBody.error), whoamiEmpty.body);
	services.agentDefaultModel = savedModel;

	section("8. providers：列出已配置的 provider 列表（供套餐绑定）");
	const providersRes = await call(providersRoute.handler, "GET", { cookie: "dsh=1" }, "");
	const providersBody = jsonOf(providersRes);
	check("providers 返回 ok", providersBody && providersBody.ok === true, providersRes.body);
	check(
		"列出已有的 provider id 与 displayName",
		Array.isArray(providersBody && providersBody.providers) && providersBody.providers.some((p) => p.id === "cotton-api" && p.displayName === "Cotton API"),
		JSON.stringify(providersBody && providersBody.providers)
	);
	check(
		"providers 不包含 baseURL 或 apiKey",
		JSON.stringify(providersBody).indexOf("baseURL") === -1 && JSON.stringify(providersBody).indexOf("apiKey") === -1,
		JSON.stringify(providersBody)
	);
	const providersNoCookie = await call(providersRoute.handler, "GET", {}, "");
	const providersNoCookieBody = jsonOf(providersNoCookie);
	check("没有会话 cookie 一律拒绝 providers", providersNoCookieBody && providersNoCookieBody.ok === false, providersNoCookie.body);

	console.log("\n" + "=".repeat(64));
	console.log((failures === 0 ? "全部通过" : "存在失败") + "：" + (total - failures) + "/" + total + " 项断言通过");
	return failures === 0 ? 0 : 1;
}

main()
	.then((code) => {
		process.exit(code);
	})
	.catch((error) => {
		console.log("测试自身出错：" + (error && error.message ? error.message : String(error)));
		if (error && error.stack) console.log(error.stack);
		process.exit(2);
	});
