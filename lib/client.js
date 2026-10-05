/**
 * dsh-balance-inquiry —— 浏览器半边（DSH 客户端 bundle）。
 *
 * 它做三件事：
 *   1. 往 `sidebar.footer.action` 列表插槽注册一个条目（order 5 < dsh-context 的 10），
 *      因此在「上下文洞察」上面渲染，样式与它同款；
 *   2. 查询余额并显示成「剩余额度：XXX ￥」，点击打开可配置的官网地址；
 *   3. 往 `settings.section` 注册一个设置页（供应商、地址、令牌、用户 ID、官网、轮询间隔、
 *      超时、换算比例、自定义脚本），配置保存在 localStorage。
 */
window.__ModuleLoader__.load({
	id: "dsh-balance-inquiry",
	factory: (require) => {
		var module = { exports: {} };

		const React = require("react");
		const h = React.createElement;

		const NS = "dsh-balance-inquiry";
		const STORAGE_CONFIG = "dsh-balance-inquiry:config";
		const STORAGE_LAST = "dsh-balance-inquiry:last-reading";
		const CSS_TAG_ID = "dsh-balance-inquiry/balance.css";
		const ENTRY_ORDER = 5; // 入口注册顺序：排在 dsh-context（10）上面
		const SECTION_ORDER = 45;

		const KEEP_LAST_GOOD_MS = 10 * 60 * 1000; // 查询失败后仍展示上次成功值的窗口
		const RETRY_DELAY_MS = 1500; // 传输层失败后重试的等待时间
		const DEFAULT_TIMEOUT_SECONDS = 10;
		const MIN_TIMEOUT_SECONDS = 2;
		const MAX_TIMEOUT_SECONDS = 30;
		const MAX_INTERVAL_MINUTES = 1440;
		const WARN_BELOW_PERCENT = 10; // 按百分比的档位低于它时显示黄色
		const ERROR_PREVIEW_CHARS = 200; // 错误体预览截断长度

		const DEFAULT_CONFIG = {
			provider: "auto", // auto | newapi | deepseek | stepfun | siliconflow | siliconflow-en | openrouter | novita | cp-* | custom
			baseUrl: "", // 需要用户自己填
			accessToken: "",
			userId: "",
			organizationId: "", // 智谱团队版：bigmodel-organization
			projectId: "", // 智谱团队版：bigmodel-project
			accessKeyId: "", // 火山方舟用量查询：AccessKey ID
			secretAccessKey: "", // 火山方舟用量查询：SecretAccessKey
			websiteUrl: "", // 留空则用接口地址；两者都空时侧边栏按钮只刷新不跳转
			autoQueryInterval: 5, // 分钟，0 = 不自动查询
			timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
			quotaPerUnit: 500000, // New API：1 ￥ = 500000 quota
			unit: "CNY", // New API 默认人民币
			customScript: ""
		};

		const PROVIDER_OPTIONS = [
			{ id: "auto", label: "自动识别（按地址判断）" },
			{ id: "newapi", label: "New API / One API" },
			{ id: "deepseek", label: "DeepSeek 官方" },
			{ id: "stepfun", label: "阶跃星辰 StepFun" },
			{ id: "siliconflow", label: "SiliconFlow 硅基流动（国内）" },
			{ id: "siliconflow-en", label: "SiliconFlow（国际）" },
			{ id: "openrouter", label: "OpenRouter" },
			{ id: "novita", label: "Novita AI" },
			{ id: "cp-kimi", label: "Token Plan · Kimi For Coding" },
			{ id: "cp-zhipu", label: "Token Plan · 智谱 GLM" },
			{ id: "cp-zhipu-team", label: "Token Plan · 智谱 GLM 团队版" },
			{ id: "cp-minimax", label: "Token Plan · MiniMax" },
			{ id: "cp-zenmux", label: "Token Plan · ZenMux" },
			{ id: "cp-volcengine", label: "Token Plan · 火山方舟（Agent/Coding Plan）" },
			{ id: "cp-opencode-go", label: "Token Plan · OpenCode Go" },
			{ id: "cp-command-code", label: "Token Plan · Command Code" },
			{ id: "custom", label: "自定义脚本" }
		];

		const NATIVE_PROVIDERS = {
			deepseek: { label: "DeepSeek", url: "https://api.deepseek.com/user/balance" },
			stepfun: { label: "StepFun", url: "https://api.stepfun.com/v1/accounts" },
			siliconflow: { label: "SiliconFlow", url: "https://api.siliconflow.cn/v1/user/info" },
			"siliconflow-en": { label: "SiliconFlow (EN)", url: "https://api.siliconflow.com/v1/user/info" },
			openrouter: { label: "OpenRouter", url: "https://openrouter.ai/api/v1/credits" },
			novita: { label: "Novita AI", url: "https://api.novita.ai/v3/user/balance" }
		};

		// New API 脚本模板；{{...}} 为脚本占位符。
		const NEW_API_TEMPLATE = [
			"({",
			'  request: {',
			'    url: "{{baseUrl}}/api/user/self",',
			'    method: "GET",',
			"    headers: {",
			'      "Content-Type": "application/json",',
			'      "Authorization": "Bearer {{accessToken}}",',
			'      "New-Api-User": "{{userId}}"',
			"    }",
			"  },",
			"  extractor: function (response) {",
			"    if (response.success && response.data) {",
			"      return {",
			'        planName: response.data.group || "默认套餐",',
			"        remaining: response.data.quota / {{rate}},",
			"        used: response.data.used_quota / {{rate}},",
			"        total: (response.data.quota + response.data.used_quota) / {{rate}},",
			'        unit: "CNY"',
			"      };",
			"    }",
			'    return { isValid: false, invalidMessage: response.message || "查询失败" };',
			"  }",
			"})"
		].join("\n");

		const GENERIC_TEMPLATE = [
			"({",
			"  request: {",
			'    url: "{{baseUrl}}/user/balance",',
			'    method: "GET",',
			"    headers: {",
			'      "Authorization": "Bearer {{apiKey}}",',
			'      "User-Agent": "dsh-balance-inquiry/1.0"',
			"    }",
			"  },",
			"  extractor: function (response) {",
			"    return {",
			"      isValid: response.is_active || true,",
			"      remaining: response.balance,",
			'      unit: "USD"',
			"    };",
			"  }",
			"})"
		].join("\n");

		//#region 文案
		const zh = {
			"entry.value": "剩余额度：{amount} {unit}",
			"entry.loading": "剩余额度：查询中…",
			"entry.idle": "剩余额度：--",
			"entry.unconfigured": "剩余额度：未配置",
			"entry.error": "剩余额度：--",
			"entry.tip": "余额查询（点击打开官网）",
			"entry.tip.balance": "{plan}：余额 {value}",
			"entry.tip.usage": "　　已用 {used} / 总额 {total}（剩余 {percent}%）",
			"entry.tip.used.only": "　　已用 {used}",
			"entry.tip.updated": "更新时间：{time}（{ago}）",
			"entry.tip.stale": "上次成功：{time}（{ago}）",
			"entry.tip.danger": "余额已用完",
			"entry.tip.failed": "额度没查到",
			"entry.tip.reason": "原因：{message}",
			"entry.tip.invalid": "无效：{message}",
			"entry.tip.unconfigured": "请在「设置 → 余额查询」里填写地址与访问令牌",
			"entry.tip.more": "另外还有 {count} 个套餐",
			"entry.tip.resets": "　　重置时间：{time}",
			"settings.nav": "余额查询",
			"settings.title": "余额查询",
			"settings.hint": "支持原生余额接口（DeepSeek、StepFun、SiliconFlow、OpenRouter、Novita）、New API 的 /api/user/self、编程套餐（Token Plan：Kimi For Coding、智谱 GLM、智谱团队版、MiniMax、ZenMux、火山方舟、OpenCode Go、Command Code），以及自定义用量脚本。请求默认由 DSH 宿主进程发出（不受浏览器跨域限制），宿主路由不可用时才回落浏览器直连。结果显示在左侧边栏底部，点击打开官网。",
			"settings.provider": "查询方式",
			"settings.provider.hint": "「自动识别」会按地址判断：命中官方厂商用官方余额接口，否则按 New API 查询",
			"settings.baseUrl": "接口地址",
			"settings.baseUrl.hint": "New API 如 https://api.example.com（末尾不要带 /）；选官方厂商时可留空",
			"settings.token": "访问令牌 / API Key",
			"settings.token.hint": "New API 用控制台「系统访问令牌」（nap_… 或 sk- 开头的 sk- 系统令牌，不是 chat 用的 API Key）；官方厂商填对应平台的 API Key",
			"settings.userId": "用户 ID",
			"settings.userId.hint": "作为 New-Api-User 请求头发送，部分站点必填",
			"settings.teamOrg": "组织 ID",
			"settings.teamOrg.hint": "智谱团队套餐必填，作为 bigmodel-organization 请求头发送",
			"settings.teamProject": "项目 ID",
			"settings.teamProject.hint": "智谱团队套餐必填，作为 bigmodel-project 请求头发送",
			"settings.accessKeyId": "AccessKey ID",
			"settings.accessKeyId.hint": "火山方舟用量查询必填：账号的 AccessKey ID（不是推理用的 API Key）",
			"settings.secretAccessKey": "SecretAccessKey",
			"settings.secretAccessKey.hint": "火山方舟用量查询必填：只用于本地签名，不会发给其它站点",
			"settings.cp.hint": "编程套餐（Token Plan）按各家的订阅接口查询，显示每个时间窗口的已用百分比：Kimi / 智谱 / MiniMax / OpenCode Go / Command Code 只需访问令牌；ZenMux 用上面的「接口地址」作为用量端点；火山方舟需要 AccessKey ID + SecretAccessKey，接口地址形如 https://ark.cn-beijing.volces.com/api/plan/v3（用于推断区域，可留空）。",
			"settings.website": "官网地址",
			"settings.website.hint": "点击侧边栏按钮时打开的网址；留空则使用接口地址",
			"settings.interval": "自动查询间隔（分钟）",
			"settings.interval.hint": "0 = 不自动查询；范围 0–1440；保存后会立即查询一次",
			"settings.timeout": "请求超时（秒）",
			"settings.timeout.hint": "2–30 秒，默认 10 秒",
			"settings.unit": "额度换算比例",
			"settings.unit.hint": "New API：1 ￥ 等于多少 quota，默认 500000（余额 = quota ÷ 该值）",
			"settings.currency": "货币单位",
			"settings.currency.hint": "New API 一般填 CNY；显示时会换算成 ￥",
			"settings.script": "自定义用量脚本",
			"settings.script.hint": "格式：({ request: { url, method, headers }, extractor: function (response) { … } })。占位符：{{apiKey}}、{{baseUrl}}、{{accessToken}}、{{userId}}、{{rate}}",
			"settings.script.fillNewApi": "填入 New API 模板",
			"settings.script.fillGeneric": "填入通用模板",
			"settings.showToken": "显示令牌",
			"settings.save": "保存",
			"settings.queryNow": "立即查询",
			"settings.reset": "恢复默认",
			"settings.openSite": "打开官网",
			"settings.status.idle": "尚未查询",
			"settings.transport.host": "查询通道：DSH 宿主进程代理（不经过浏览器，无跨域限制）",
			"settings.transport.browser": "查询通道：浏览器直连（目标站必须允许跨域，否则会被拦）",
			"settings.transport.unknown": "查询通道：尚未发起请求",
			"settings.status.loading": "查询中…",
			"settings.status.unconfigured": "尚未填写访问令牌",
			"settings.status.unconfigured.endpoint": "尚未填写接口地址",
			"settings.status.ready": "余额 {amount} ｜ 已用 {used} ｜ 总额 {total} ｜ 剩余 {percent}%",
			"settings.status.ready.short": "余额 {amount}",
			"settings.status.error": "额度没查到：{message}",
			"settings.status.updated": "上次成功：{time}（{ago}）",
			"settings.status.stale": "展示的是上次成功的数据，重试中…",
			"settings.status.invalid": "服务端返回无效结果：{message}",
			"settings.saved": "已保存",
			"settings.plans": "查询结果（{count} 项）",
			"settings.group": "分组：{group}",
			"settings.resets": "重置时间：{time}",
			"settings.updated.at": "查询时间：{time}（{ago}）"
		};
		const en = {
			"entry.value": "Quota left: {amount} {unit}",
			"entry.loading": "Quota left: loading…",
			"entry.idle": "Quota left: --",
			"entry.unconfigured": "Quota left: not set up",
			"entry.error": "Quota left: --",
			"entry.tip": "Balance check (click to open the provider site)",
			"entry.tip.balance": "{plan}: balance {value}",
			"entry.tip.usage": "    used {used} / total {total} ({percent}% left)",
			"entry.tip.used.only": "    used {used}",
			"entry.tip.updated": "Updated: {time} ({ago})",
			"entry.tip.stale": "Last success: {time} ({ago})",
			"entry.tip.danger": "No balance left",
			"entry.tip.failed": "Balance unavailable",
			"entry.tip.reason": "Reason: {message}",
			"entry.tip.invalid": "Invalid: {message}",
			"entry.tip.unconfigured": "Set the endpoint and token in Settings → Balance",
			"entry.tip.more": "{count} more plan(s)",
			"entry.tip.resets": "    resets at {time}",
			"settings.nav": "Balance",
			"settings.title": "Balance query",
			"settings.hint": "Supports native balance APIs (DeepSeek, StepFun, SiliconFlow, OpenRouter, Novita), New API's /api/user/self, coding plans / token plans (Kimi For Coding, Zhipu GLM, Zhipu team, MiniMax, ZenMux, Volcengine Ark, OpenCode Go, Command Code), and custom usage scripts. Requests are sent by the DSH host process by default (no browser CORS restriction), falling back to a direct browser fetch when the host route is unavailable. The result shows at the sidebar foot; clicking opens the provider site.",
			"settings.provider": "Query method",
			"settings.provider.hint": "“Auto” detects from the URL: known vendors use their native balance API, anything else is treated as New API",
			"settings.baseUrl": "Endpoint",
			"settings.baseUrl.hint": "New API, e.g. https://api.example.com (no trailing slash); can be empty for native vendors",
			"settings.token": "Access token / API key",
			"settings.token.hint": "New API: the console's system access token; native vendors: that platform's API key",
			"settings.userId": "User ID",
			"settings.userId.hint": "sent as the New-Api-User header; required by some deployments",
			"settings.teamOrg": "Organization ID",
			"settings.teamOrg.hint": "required for the Zhipu team plan; sent as bigmodel-organization",
			"settings.teamProject": "Project ID",
			"settings.teamProject.hint": "required for the Zhipu team plan; sent as bigmodel-project",
			"settings.accessKeyId": "AccessKey ID",
			"settings.accessKeyId.hint": "required for Volcengine Ark usage queries: the account's AccessKey ID (not the inference API key)",
			"settings.secretAccessKey": "SecretAccessKey",
			"settings.secretAccessKey.hint": "required for Volcengine Ark usage queries; used only for local signing",
			"settings.cp.hint": "Coding plans (token plans) are read from each vendor's subscription API and show the used percentage of every window: Kimi / Zhipu / MiniMax / OpenCode Go / Command Code need only the token; ZenMux uses the Endpoint above as its usage URL; Volcengine Ark needs the AccessKey ID + SecretAccessKey and an endpoint like https://ark.cn-beijing.volces.com/api/plan/v3 (used to infer the region, may be empty).",
			"settings.website": "Provider website",
			"settings.website.hint": "opened when the sidebar button is clicked; empty means the endpoint",
			"settings.interval": "Auto query interval (minutes)",
			"settings.interval.hint": "0 = never; 0–1440; saving queries once immediately",
			"settings.timeout": "Request timeout (seconds)",
			"settings.timeout.hint": "2–30 seconds, default 10",
			"settings.unit": "Quota conversion rate",
			"settings.unit.hint": "New API: how many quota units equal 1 ￥, default 500000",
			"settings.currency": "Currency unit",
			"settings.currency.hint": "CNY for most New API deployments",
			"settings.script": "Custom usage script",
			"settings.script.hint": "Format: ({ request: { url, method, headers }, extractor: function (response) { … } }). Placeholders: {{apiKey}}, {{baseUrl}}, {{accessToken}}, {{userId}}, {{rate}}",
			"settings.script.fillNewApi": "Fill New API template",
			"settings.script.fillGeneric": "Fill generic template",
			"settings.showToken": "Show token",
			"settings.save": "Save",
			"settings.queryNow": "Query now",
			"settings.reset": "Restore defaults",
			"settings.openSite": "Open website",
			"settings.status.idle": "not queried yet",
			"settings.transport.host": "Transport: DSH host process proxy (no browser, no CORS limit)",
			"settings.transport.browser": "Transport: direct browser fetch (the target must allow CORS)",
			"settings.transport.unknown": "Transport: no request sent yet",
			"settings.status.loading": "querying…",
			"settings.status.unconfigured": "no access token yet",
			"settings.status.unconfigured.endpoint": "no endpoint yet",
			"settings.status.ready": "balance {amount} | used {used} | total {total} | {percent}% left",
			"settings.status.ready.short": "balance {amount}",
			"settings.status.error": "balance unavailable: {message}",
			"settings.status.updated": "last success: {time} ({ago})",
			"settings.status.stale": "showing the last successful result, retrying…",
			"settings.status.invalid": "server returned an invalid result: {message}",
			"settings.saved": "Saved",
			"settings.plans": "Result ({count} item(s))",
			"settings.group": "Group: {group}",
			"settings.resets": "resets at {time}",
			"settings.updated.at": "Queried: {time} ({ago})"
		};
		//#endregion

		//#region 通用工具
		function format(template, params) {
			return String(template === undefined || template === null ? "" : template).replace(/\{(\w+(?:\.\w+)*)\}/g, (match, key) => (params && params[key] !== undefined ? String(params[key]) : match));
		}

		function formatMoney(value) {
			const number = Number(value);
			if (!Number.isFinite(number)) return "--";
			const fixed = Math.abs(number).toFixed(2);
			const parts = fixed.split(".");
			const head = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
			return (number < 0 ? "-" : "") + head + "." + parts[1];
		}

		/** 把常见币种换成符号。 */
		function unitSymbol(unit) {
			const text = String(unit === undefined || unit === null ? "" : unit).trim();
			if (!text) return "";
			const lower = text.toLowerCase();
			if (lower === "%") return "%";
			if (lower === "cny" || lower === "rmb" || lower === "yuan" || text === "￥" || text === "¥") return "￥";
			if (lower === "usd" || text === "$") return "$";
			return text;
		}

		function formatValue(remaining, unit) {
			if (typeof remaining !== "number" || !Number.isFinite(remaining)) return "--";
			const symbol = unitSymbol(unit);
			return formatMoney(remaining) + (symbol ? " " + symbol : "");
		}

		function formatTime(at) {
			if (typeof at !== "number" || at <= 0) return "";
			try {
				return new Date(at).toLocaleString();
			} catch (error) {
				return "";
			}
		}

		/** 刚刚 / N 分钟前 / N 小时前 / N 天前 */
		function formatRelativeTime(at, now) {
			if (typeof at !== "number" || at <= 0) return "";
			const current = typeof now === "number" ? now : Date.now();
			const seconds = Math.max(0, Math.floor((current - at) / 1000));
			if (seconds < 60) return "刚刚";
			const minutes = Math.floor(seconds / 60);
			if (minutes < 60) return minutes + " 分钟前";
			const hours = Math.floor(minutes / 60);
			if (hours < 24) return hours + " 小时前";
			return Math.floor(hours / 24) + " 天前";
		}

		function clampNumber(value, fallback, min, max) {
			// 空串来自被清空的数字输入框（例如用户删掉间隔），按「未填写」处理，回落到默认值。
			if (value === "" || value === null || value === undefined) return fallback;
			const number = Number(value);
			if (!Number.isFinite(number)) return fallback;
			return Math.min(max, Math.max(min, number));
		}

		/** 兼容数字与数字字符串。 */
		function parseNumber(value) {
			if (typeof value === "number") return Number.isFinite(value) ? value : null;
			if (typeof value === "string" && value.trim() !== "") {
				const number = Number(value);
				return Number.isFinite(number) ? number : null;
			}
			return null;
		}

		function preview(text) {
			const raw = String(text === undefined || text === null ? "" : text);
			if (raw.length <= ERROR_PREVIEW_CHARS) return raw;
			return raw.slice(0, ERROR_PREVIEW_CHARS) + "…";
		}

		function originOf(url) {
			try {
				return new URL(String(url)).host || String(url);
			} catch (error) {
				return String(url || "");
			}
		}
		//#endregion

		//#region 结果契约
		/** 一条额度记录：{ planName, remaining, total, used, unit, isValid, invalidMessage, extra } */
		function makeItem(planName, remaining, total, used, unit, isValid, invalidMessage, extra) {
			return {
				planName: planName === undefined ? null : planName,
				remaining: typeof remaining === "number" ? remaining : null,
				total: typeof total === "number" ? total : null,
				used: typeof used === "number" ? used : null,
				unit: unit === undefined ? null : unit,
				isValid: isValid === undefined ? true : isValid,
				invalidMessage: invalidMessage === undefined ? null : invalidMessage,
				extra: extra === undefined ? null : extra
			};
		}

		function okResult(data) {
			return { success: true, data: data && data.length ? data : null, error: null };
		}

		function failResult(message, data) {
			return { success: false, data: data && data.length ? data : null, error: String(message || "查询失败") };
		}

		/** 鉴权失败时给一条无效记录 + error 文案。 */
		function authFailResult(message) {
			return failResult(message, [makeItem(null, null, null, null, null, false, message, null)]);
		}

		/** 一条「无效」记录（isValid:false 时走 success:true + 无效项）。 */
		function invalidResult(message) {
			return okResult([makeItem(null, null, null, null, null, false, String(message || "查询失败"), null)]);
		}

		/**
		 * 只有瞬时失败才允许继续展示上次成功值。
		 * 白名单：网络类文案，或文案里首个 "HTTP <code>" 为 5xx/429；其余一律视为确定性失败。
		 */
		function isTransientMessage(message) {
			const text = String(message === undefined || message === null ? "" : message).toLowerCase();
			if (!text) return false;
			if (
				text.includes("network error") ||
				text.includes("request failed") ||
				text.includes("请求失败") ||
				text.includes("failed to read response") ||
				text.includes("读取响应失败") ||
				text.includes("请求超时")
			) {
				return true;
			}
			const matched = text.match(/http\s+(\d{3})/);
			if (matched) {
				const status = Number(matched[1]);
				return (status >= 500 && status <= 599) || status === 429;
			}
			return false;
		}

		function isTransientResult(result) {
			if (!result || result.success) return false;
			return isTransientMessage(result.error);
		}

		function hasInvalidItem(result) {
			return Boolean(result && result.data && result.data.some((item) => item && item.isValid === false));
		}

		function firstInvalidMessage(result) {
			if (!result || !result.data) return "";
			const invalid = result.data.find((item) => item && item.isValid === false && item.invalidMessage);
			return invalid ? String(invalid.invalidMessage) : "";
		}

		/** 传输层失败：可重试、可沿用上次成功值。 */
		function transientError(message) {
			const error = new Error(message);
			error.transient = true;
			return error;
		}

		function describeError(error, baseUrl) {
			if (!error) return "unknown error";
			if (error.transient && error.message) return String(error.message);
			const where = baseUrl ? " " + originOf(baseUrl) : "";
			if (error.name === "AbortError") return "请求超时 请求失败 Request failed: timeout";
			if (error.name === "TypeError") {
				return "网络错误 Network error: 无法连接" + where + "（可能是网络不通，或该域名未在响应头里允许跨域）";
			}
			return String(error.message || error);
		}

		/** 显示错误：优先用结果的 error，其次才是异常本身。 */
		function errorTextOf(state) {
			if (state.error) return state.error;
			if (state.errorHint) return state.errorHint;
			return "unknown error";
		}
		//#endregion

		//#region 配置与缓存（localStorage，失败时退化为内存）
		let memoryConfig = null;

		/** 读配置。 */
		function readStored(key) {
			try {
				return window.localStorage.getItem(key);
			} catch (error) {
				return null;
			}
		}

		function writeStored(key, value) {
			try {
				window.localStorage.setItem(key, value);
				return true;
			} catch (error) {
				return false;
			}
		}

		function normalizeConfig(raw) {
			const config = Object.assign({}, DEFAULT_CONFIG);
			if (raw && typeof raw === "object") {
				for (const key of Object.keys(DEFAULT_CONFIG)) {
					const value = raw[key];
					// 空串是「有意清空」（例如清掉令牌或官网地址），必须原样保留。
					if (value !== undefined && value !== null) config[key] = value;
				}
			}
			const known = PROVIDER_OPTIONS.some((item) => item.id === config.provider);
			if (!known) config.provider = DEFAULT_CONFIG.provider;
			config.baseUrl = String(config.baseUrl || "").trim().replace(/\/+$/, "");
			config.websiteUrl = String(config.websiteUrl || "").trim();
			config.accessToken = String(config.accessToken || "").trim();
			config.userId = String(config.userId || "").trim();
			config.unit = String(config.unit || DEFAULT_CONFIG.unit).trim() || DEFAULT_CONFIG.unit;
			config.customScript = String(config.customScript === undefined || config.customScript === null ? "" : config.customScript);
			config.autoQueryInterval = Math.round(clampNumber(config.autoQueryInterval, DEFAULT_CONFIG.autoQueryInterval, 0, MAX_INTERVAL_MINUTES));
			config.timeoutSeconds = clampNumber(config.timeoutSeconds, DEFAULT_CONFIG.timeoutSeconds, MIN_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS);
			config.quotaPerUnit = clampNumber(config.quotaPerUnit, DEFAULT_CONFIG.quotaPerUnit, 1, 1e12);
			return config;
		}

		function loadConfig() {
			if (memoryConfig) return memoryConfig;
			const raw = readStored(STORAGE_CONFIG);
			if (raw === null) {
				memoryConfig = normalizeConfig(null);
				return memoryConfig;
			}
			try {
				memoryConfig = normalizeConfig(JSON.parse(raw));
			} catch (error) {
				memoryConfig = normalizeConfig(null);
			}
			return memoryConfig;
		}

		function persistConfig(config) {
			memoryConfig = config;
			writeStored(STORAGE_CONFIG, JSON.stringify(config));
		}

		/** 上次成功的快照（keep-last-good 用），重启后仍能立刻显示。 */
		function loadCachedSnapshot() {
			const raw = readStored(STORAGE_LAST);
			if (raw === null) return null;
			try {
				const snapshot = JSON.parse(raw);
				if (snapshot && snapshot.data && snapshot.data.success && typeof snapshot.at === "number") {
					return { data: snapshot.data, at: snapshot.at, config: snapshot.config || null };
				}
			} catch (error) {
				// 忽略坏掉的缓存
			}
			return null;
		}

		function persistSnapshot(snapshot) {
			writeStored(STORAGE_LAST, JSON.stringify(snapshot));
		}
		//#endregion

		//#region 宿主代理（同源路由，见 lib/index.js）
		/**
		 * 浏览器直连受 CORS 限制：目标站没回 `Access-Control-Allow-Origin` 时 fetch 直接被拦。
		 * 所以先走宿主进程（宿主半边的 dsh-host-webserver 路由，无 CORS），
		 * 宿主路由不可用时再退回浏览器直连。
		 */
		const PROXY_PATH = "/plugins/dsh-balance-inquiry/proxy";
		const PROXY_STATE = { mode: "unknown" }; // unknown | host | browser

		function proxyUrl() {
			try {
				if (typeof location === "undefined" || !location || !location.href) return "";
				return new URL(PROXY_PATH, location.href).toString();
			} catch (error) {
				return "";
			}
		}

		/** 经宿主代理发请求；这条路不可用时返回 null（调用方回落浏览器直连）。 */
		async function sendViaHost(request, seconds, controller) {
			if (PROXY_STATE.mode === "browser") return null;
			const url = proxyUrl();
			if (!url) return null;
			let response;
			try {
				response = await fetch(url, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						url: request.url,
						method: request.method || "GET",
						headers: request.headers || {},
						body: request.body === undefined || request.body === null ? null : request.body,
						timeoutSeconds: seconds
					}),
					cache: "no-store",
					credentials: "same-origin",
					...(controller ? { signal: controller.signal } : {})
				});
			} catch (error) {
				if (error && error.name === "AbortError") throw error;
				PROXY_STATE.mode = "browser";
				return null;
			}
			// 我们自己的路由只会回 200 + JSON（上游的状态码在 payload 里）；
			// 其他状态码说明这条路由不存在（旧宿主、webserver 未启用、cookie 被拒）→ 改走直连。
			if (!response || response.status !== 200) {
				PROXY_STATE.mode = "browser";
				return null;
			}
			let payload = null;
			try {
				payload = JSON.parse((await readBodyText(response)) || "null");
			} catch (error) {
				payload = null;
			}
			if (!payload || typeof payload !== "object" || (payload.ok !== true && !payload.error)) {
				PROXY_STATE.mode = "browser";
				return null;
			}
			PROXY_STATE.mode = "host";
			if (payload.ok !== true) {
				const failure = payload.error || {};
				throw transientError(
					failure.message || (failure.kind === "timeout" ? "请求超时 请求失败 Request failed: timeout after " + seconds + "s" : "网络错误 Network error: 宿主代理请求失败")
				);
			}
			const status = Number(payload.status);
			const normalized = Number.isFinite(status) ? status : 0;
			return { status: normalized, ok: normalized >= 200 && normalized < 300, text: payload.body === undefined || payload.body === null ? "" : String(payload.body) };
		}
		//#endregion

		//#region HTTP（send 失败 / 读体失败抛错；非 2xx 交给调用方判定）
		async function readBodyText(response) {
			if (response && typeof response.text === "function") return String(await response.text());
			if (response && typeof response.json === "function") return JSON.stringify(await response.json());
			return "";
		}

		/**
		 * 发一个请求，返回 { status, ok, text }。
		 * 先尝试宿主代理（无 CORS），再退回浏览器直连。
		 * 传输层失败（发不出去 / 超时 / 读体中断）抛 transient 错误，可以重试。
		 */
		async function httpSend(request, timeoutSeconds) {
			const seconds = clampNumber(timeoutSeconds, DEFAULT_TIMEOUT_SECONDS, MIN_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS);
			const controller = typeof AbortController === "function" ? new AbortController() : null;
			const timer = controller ? setTimeout(() => controller.abort(), seconds * 1000) : 0;
			try {
				try {
					const viaHost = await sendViaHost(request, seconds, controller);
					if (viaHost) return viaHost;
				} catch (error) {
					if (error && error.transient) throw error; // 宿主明确报告的上游失败（含超时）
					if (error && error.name === "AbortError") throw transientError("请求超时 请求失败 Request failed: timeout after " + seconds + "s");
					// 代理自身异常（例如响应无法解析）→ 继续尝试浏览器直连
				}
				let response;
				try {
					response = await fetch(request.url, {
						method: request.method || "GET",
						headers: request.headers || {},
						body: request.body === undefined || request.body === null ? undefined : request.body,
						cache: "no-store",
						credentials: "omit",
						redirect: "follow",
						...(controller ? { signal: controller.signal } : {})
					});
				} catch (error) {
					if (error && error.name === "AbortError") {
						throw transientError("请求超时 请求失败 Request failed: timeout after " + seconds + "s");
					}
					if (error && error.name === "TypeError") {
						throw transientError(
							"网络错误 Network error: 无法连接 " +
								originOf(request.url) +
								"（该地址没回跨域许可 Access-Control-Allow-Origin；插件已试过宿主代理，若仍失败请重启 DSH 让宿主半边生效）"
						);
					}
					throw transientError("网络错误 Network error: " + String((error && error.message) || error));
				}
				let text = "";
				try {
					text = await readBodyText(response);
				} catch (error) {
					throw transientError("读取响应失败 Failed to read response: " + String((error && error.message) || error));
				}
				const status = Number(response && response.status);
				const ok = response && response.ok !== undefined ? response.ok !== false : !(status >= 400);
				return { status: Number.isFinite(status) ? status : 0, ok: Boolean(ok), text: text };
			} finally {
				if (timer) clearTimeout(timer);
			}
		}

		async function httpGetJson(url, headers, timeoutSeconds) {
			const response = await httpSend({ url: url, method: "GET", headers: headers }, timeoutSeconds);
			if (response.status === 401 || response.status === 403) {
				return { authFailed: true, status: response.status, text: response.text, body: null };
			}
			if (!response.ok) {
				return { error: "API error (HTTP " + response.status + "): " + preview(response.text), status: response.status, text: response.text, body: null };
			}
			try {
				return { body: response.text ? JSON.parse(response.text) : {}, status: response.status, text: response.text };
			} catch (error) {
				return { error: "Failed to parse response: " + String((error && error.message) || error), status: response.status, text: response.text, body: null };
			}
		}
		//#endregion

		//#region 原生余额供应商
		/** 按 URL 小写包含判断，识别不了就交给 New API。 */
		function detectNativeProvider(baseUrl) {
			const url = String(baseUrl || "").toLowerCase();
			if (!url) return "";
			if (url.includes("api.deepseek.com")) return "deepseek";
			if (url.includes("api.stepfun.ai") || url.includes("api.stepfun.com")) return "stepfun";
			if (url.includes("api.siliconflow.cn")) return "siliconflow";
			if (url.includes("api.siliconflow.com")) return "siliconflow-en";
			if (url.includes("openrouter.ai")) return "openrouter";
			if (url.includes("api.novita.ai")) return "novita";
			return "";
		}

		function resolveProvider(config) {
			if (config.provider === "custom") return "custom";
			if (config.provider && config.provider !== "auto") return config.provider;
			const detected = detectNativeProvider(config.baseUrl);
			if (detected) return detected;
			// 编程套餐（Token Plan）也支持自动识别；团队版必须显式选择。
			return detectCodingPlanProvider(config.baseUrl) || "newapi";
		}

		async function queryNative(providerId, config, authHeaders) {
			const provider = NATIVE_PROVIDERS[providerId];
			if (!provider) return failResult("Unknown balance provider");
			const headers = Object.assign({ Accept: "application/json" }, authHeaders);
			const response = await httpGetJson(provider.url, headers, config.timeoutSeconds);
			if (response.authFailed) return authFailResult("Authentication failed (HTTP " + response.status + ")");
			if (response.error) return failResult(response.error);
			const body = response.body || {};
			if (providerId === "deepseek") {
				const infos = Array.isArray(body.balance_infos) ? body.balance_infos : [];
				const available = body.is_available !== false;
				const items = [];
				for (const info of infos) {
					const currency = info && typeof info.currency === "string" ? info.currency : "CNY";
					const total = parseNumber(info && info.total_balance);
					items.push(
						makeItem(currency, total, null, null, currency, available, available ? null : "Insufficient balance", null)
					);
				}
				if (!items.length) return failResult("Failed to parse response: 缺少字段 'balance_infos'");
				return okResult(items);
			}
			if (providerId === "stepfun") {
				const balance = parseNumber(body.balance);
				if (balance === null) return failResult("Failed to parse response: 缺少字段 'balance'");
				return okResult([makeItem("StepFun", balance, null, null, "CNY", true, null, null)]);
			}
			if (providerId === "siliconflow" || providerId === "siliconflow-en") {
				const data = body.data;
				if (!data || typeof data !== "object") return failResult("Failed to parse response: 缺少字段 'data'");
				const balance = parseNumber(data.totalBalance);
				if (balance === null) return failResult("Failed to parse response: 缺少字段 'totalBalance'");
				const unit = providerId === "siliconflow" ? "CNY" : "USD";
				return okResult([makeItem(provider.label, balance, null, null, unit, true, null, null)]);
			}
			if (providerId === "openrouter") {
				const data = body.data;
				if (!data || typeof data !== "object") return failResult("Failed to parse response: 缺少字段 'data'");
				const total = parseNumber(data.total_credits);
				const used = parseNumber(data.total_usage);
				if (total === null) return failResult("Failed to parse response: 缺少字段 'total_credits'");
				const spent = used === null ? 0 : used;
				const remaining = total - spent;
				return okResult([
					makeItem("OpenRouter", remaining, total, spent, "USD", remaining > 0, remaining > 0 ? null : "No credits remaining", null)
				]);
			}
			if (providerId === "novita") {
				const raw = parseNumber(body.availableBalance);
				if (raw === null) return failResult("Failed to parse response: 缺少字段 'availableBalance'");
				const balance = raw / 10000; // Novita 金额单位 0.0001 USD
				return okResult([
					makeItem("Novita AI", balance, null, null, "USD", balance > 0, balance > 0 ? null : "No balance remaining", null)
				]);
			}
			return failResult("Unknown balance provider");
		}
		//#endregion

		//#region 编程套餐（Token Plan / Coding Plan）
		// 全部供应商统一 15s 超时；鉴权失败 → credential expired + "Authentication failed (HTTP {status})"。
		const CP_TIMEOUT_SECONDS = 15;
		const CP_TIER_FIVE_HOUR = "five_hour";
		const CP_TIER_WEEKLY = "weekly_limit";
		const CP_TIER_MONTHLY = "monthly";
		const CP_TIER_LABELS = { five_hour: "5 小时窗口", weekly_limit: "周窗口", monthly: "月窗口" };
		const CP_MANUAL_ONLY = "cp-zhipu-team"; // 团队版永不自动识别，必须显式选择

		/** 8 个编程套餐 id 与自动识别顺序（先命中先赢）。 */
		const CODING_PLAN_PROVIDERS = [
			{ id: "cp-kimi", pattern: /api\.kimi\.com\/coding/i },
			{ id: "cp-zhipu", pattern: /bigmodel\.cn|api\.z\.ai/i },
			{ id: "cp-zhipu-team", pattern: null },
			{ id: "cp-minimax", hosts: ["api.minimaxi.com", "api.minimax.cn", "api.minimax.io"] },
			{ id: "cp-zenmux", pattern: /zenmux/i },
			{ id: "cp-volcengine", pattern: /volces\.com\/api\/(plan|coding)/i },
			{ id: "cp-opencode-go", pattern: /opencode\.ai\/zen\/go/i },
			{ id: "cp-command-code", pattern: /api\.commandcode\.ai\/provider(?:[/?#]|$)/i }
		];

		function cpHost(baseUrl) {
			const host = originOf(baseUrl).toLowerCase();
			const bare = host.indexOf("@") >= 0 ? host.slice(host.lastIndexOf("@") + 1) : host;
			const colon = bare.indexOf(":");
			return colon >= 0 ? bare.slice(0, colon) : bare;
		}

		/** host 边界匹配，不能只用 contains。 */
		function cpHostMatchesAny(host, hosts) {
			return hosts.some((item) => host === item || host.endsWith("." + item));
		}

		function detectCodingPlanProvider(baseUrl) {
			const url = String(baseUrl || "");
			if (!url) return "";
			const host = cpHost(url);
			for (const item of CODING_PLAN_PROVIDERS) {
				if (item.pattern && item.pattern.test(url)) return item.id;
				if (item.hosts && cpHostMatchesAny(host, item.hosts)) return item.id;
			}
			return "";
		}

		function isCodingPlanProvider(provider) {
			return CODING_PLAN_PROVIDERS.some((item) => item.id === provider);
		}

		function cpNum(value, fallback) {
			const number = parseNumber(value);
			return number === null ? fallback : number;
		}

		function cpFirstString(values) {
			for (const value of values) {
				if (typeof value === "string" && value.trim() !== "") return value;
			}
			return "";
		}

		/** coding_plan.rs extract_reset_time：字符串原样；<=0 视为无窗口；秒/毫秒自动识别 → RFC3339。 */
		function cpExtractResetTime(value) {
			if (typeof value === "string") return value === "" ? null : value;
			const number = parseNumber(value);
			if (number === null || number <= 0) return null;
			return cpMillisToIso(number < 1e12 ? number * 1000 : number);
		}

		function cpMillisToIso(millis) {
			const date = new Date(millis);
			if (Number.isNaN(date.getTime())) return null;
			return date.toISOString();
		}

		function cpTier(name, utilization, resetsAt, usedValueUsd, maxValueUsd) {
			return {
				name: name,
				utilization: Number.isFinite(utilization) ? utilization : 0,
				resetsAt: resetsAt === undefined ? null : resetsAt,
				usedValueUsd: parseNumber(usedValueUsd),
				maxValueUsd: parseNumber(maxValueUsd)
			};
		}

		function cpOk(tiers, credentialMessage) {
			return { success: true, error: null, credentialStatus: "valid", credentialMessage: credentialMessage || null, errorDetail: null, tiers: tiers };
		}

		function cpError(message) {
			return { success: false, error: String(message), credentialStatus: "unknown", credentialMessage: null, errorDetail: null, tiers: [] };
		}

		function cpAuthError(status) {
			return { success: false, error: "Authentication failed (HTTP " + status + ")", credentialStatus: "expired", credentialMessage: "Invalid API key", errorDetail: null, tiers: [] };
		}

		/** 带服务端细节的鉴权失败（火山 OpenAPI 的 Code/Message）。 */
		function cpAuthDetail(detail) {
			return { success: false, error: String(detail), credentialStatus: "expired", credentialMessage: "Invalid API key", errorDetail: null, tiers: [] };
		}

		function cpNotFound(message) {
			return { success: false, error: String(message), credentialStatus: "not_found", credentialMessage: null, errorDetail: null, tiers: [] };
		}

		/** 把套餐返回的档位翻译成本插件的结果契约（unit % 触发「快用完」预警）。 */
		function cpToResult(quota) {
			if (!quota.success) {
				if (quota.credentialStatus === "expired") return authFailResult(quota.error);
				return failResult(quota.error);
			}
			const planName = quota.credentialMessage ? String(quota.credentialMessage) : "";
			const items = quota.tiers.map((tier) => {
				const label = CP_TIER_LABELS[tier.name] || tier.name;
				const title = planName ? label + "（" + planName + "）" : label;
				if (typeof tier.maxValueUsd === "number" && typeof tier.usedValueUsd === "number" && tier.maxValueUsd > 0) {
					return makeItem(title, Math.max(tier.maxValueUsd - tier.usedValueUsd, 0), tier.maxValueUsd, tier.usedValueUsd, "USD", true, null, tier.resetsAt || null);
				}
				return makeItem(title, Math.max(100 - tier.utilization, 0), 100, tier.utilization, "%", true, null, tier.resetsAt || null);
			});
			return okResult(items);
		}

		/** 统一请求：GET/POST（可选 body）。 */
		async function cpRequest(url, options, config) {
			const opts = options || {};
			const response = await httpSend(
				{ url: url, method: opts.method || "GET", headers: Object.assign({}, opts.headers || {}), body: opts.body === undefined ? null : opts.body },
				clampNumber(config.timeoutSeconds, CP_TIMEOUT_SECONDS, MIN_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS)
			);
			const out = { status: response.status, ok: response.ok, text: response.text || "", body: null, parseError: null };
			try {
				out.body = out.text ? JSON.parse(out.text) : {};
			} catch (error) {
				out.parseError = String((error && error.message) || error);
			}
			return out;
		}

		/** 统一的 401/403、非 2xx、解析失败判定；返回 null 表示可以继续解析。 */
		function cpGuard(response) {
			if (response.status === 401 || response.status === 403) return cpAuthError(response.status);
			if (!response.ok) return cpError("API error (HTTP " + response.status + "): " + preview(response.text));
			if (response.parseError) return cpError("Failed to parse response: " + response.parseError);
			return null;
		}

		/** 每家的请求头（智谱不加 Bearer；MiniMax 不带 Accept）。 */
		async function cpGetJson(url, headers, config, options) {
			const response = await cpRequest(url, { method: (options && options.method) || "GET", headers: headers, body: options && options.body }, config);
			return { status: response.status, ok: response.ok, text: response.text, body: response.body, parseError: response.parseError, guard: cpGuard(response) };
		}

		// ---- Kimi For Coding（query_kimi）----
		async function cpQueryKimi(config, apiKey) {
			const out = await cpGetJson("https://api.kimi.com/coding/v1/usages", { Authorization: "Bearer " + apiKey, Accept: "application/json" }, config);
			if (out.guard) return out.guard;
			const body = out.body || {};
			const tiers = [];
			const limits = Array.isArray(body.limits) ? body.limits : [];
			for (const entry of limits) {
				const detail = entry && typeof entry === "object" && entry.detail && typeof entry.detail === "object" ? entry.detail : {};
				const limit = cpNum(detail.limit, 1);
				const remaining = cpNum(detail.remaining, 0);
				const used = Math.max(limit - remaining, 0);
				tiers.push(cpTier(CP_TIER_FIVE_HOUR, limit > 0 ? (used / limit) * 100 : 0, cpExtractResetTime(detail.resetTime)));
			}
			const usage = body.usage && typeof body.usage === "object" ? body.usage : null;
			if (usage) {
				const limit = cpNum(usage.limit, 1);
				const remaining = cpNum(usage.remaining, 0);
				const used = Math.max(limit - remaining, 0);
				tiers.push(cpTier(CP_TIER_WEEKLY, limit > 0 ? (used / limit) * 100 : 0, cpExtractResetTime(usage.resetTime)));
			}
			return cpOk(tiers, null);
		}

		// ---- 智谱 GLM（个人版 query_zhipu / zhipu_quota_from_body）----
		function cpZhipuQuotaBase(baseUrl) {
			return String(baseUrl || "").toLowerCase().includes("bigmodel.cn") ? "https://open.bigmodel.cn" : "https://api.z.ai";
		}

		/** classify_zhipu_window：只锚 unit（3 = 5 小时，6 = 周），不绑 number。 */
		function cpZhipuWindow(unit) {
			const value = parseNumber(unit);
			if (value === 3) return CP_TIER_FIVE_HOUR;
			if (value === 6) return CP_TIER_WEEKLY;
			return null;
		}

		function cpParseZhipuTokenTiers(data) {
			const classified = {};
			const unclassified = [];
			const limits = data && Array.isArray(data.limits) ? data.limits : [];
			for (const item of limits) {
				if (!item || typeof item !== "object") continue;
				const type = String(item.type || "").trim().toUpperCase();
				if (type !== "TOKENS_LIMIT" && type !== "CREDIT_LIMIT") continue;
				const utilization = cpNum(item.percentage, 0);
				const resetsAt = cpExtractResetTime(item.nextResetTime);
				const name = cpZhipuWindow(item.unit);
				if (name) {
					if (!classified[name]) classified[name] = cpTier(name, utilization, resetsAt);
					continue;
				}
				unclassified.push({ utilization: utilization, resetsAt: resetsAt });
			}
			unclassified.sort((left, right) => {
				const leftHas = left.resetsAt ? 1 : 0;
				const rightHas = right.resetsAt ? 1 : 0;
				if (leftHas !== rightHas) return leftHas - rightHas;
				return String(left.resetsAt || "").localeCompare(String(right.resetsAt || ""));
			});
			for (const entry of unclassified) {
				if (!classified[CP_TIER_FIVE_HOUR]) classified[CP_TIER_FIVE_HOUR] = cpTier(CP_TIER_FIVE_HOUR, entry.utilization, entry.resetsAt);
				else if (!classified[CP_TIER_WEEKLY]) classified[CP_TIER_WEEKLY] = cpTier(CP_TIER_WEEKLY, entry.utilization, entry.resetsAt);
			}
			const tiers = [];
			if (classified[CP_TIER_FIVE_HOUR]) tiers.push(classified[CP_TIER_FIVE_HOUR]);
			if (classified[CP_TIER_WEEKLY]) tiers.push(classified[CP_TIER_WEEKLY]);
			return tiers;
		}

		function cpZhipuQuotaFromBody(body) {
			if (body && body.success === false) return cpError("API error: " + (typeof body.msg === "string" && body.msg ? body.msg : "Unknown error"));
			const data = body && body.data && typeof body.data === "object" ? body.data : null;
			if (!data) return cpError("Missing 'data' field in response");
			const level = typeof data.level === "string" && data.level.trim() !== "" ? data.level.trim() : null;
			return cpOk(cpParseZhipuTokenTiers(data), level);
		}

		async function cpQueryZhipu(config, apiKey) {
			const url = cpZhipuQuotaBase(config.baseUrl) + "/api/monitor/usage/quota/limit";
			const out = await cpGetJson(url, { Authorization: apiKey, "Content-Type": "application/json", "Accept-Language": "en-US,en" }, config);
			if (out.guard) return out.guard;
			return cpZhipuQuotaFromBody(out.body);
		}

		async function cpQueryZhipuTeam(config, apiKey, organizationId, projectId) {
			const url = "https://open.bigmodel.cn/api/monitor/usage/quota/limit?type=2";
			const headers = { Authorization: apiKey, "bigmodel-organization": organizationId, "bigmodel-project": projectId, "Content-Type": "application/json", "Accept-Language": "en-US,en" };
			const out = await cpGetJson(url, headers, config);
			if (out.guard) return out.guard;
			return cpZhipuQuotaFromBody(out.body);
		}

		// ---- MiniMax（query_minimax）----
		async function cpQueryMinimax(config, apiKey, isCn) {
			const base = isCn ? "https://api.minimaxi.com" : "https://api.minimax.io";
			const out = await cpGetJson(base + "/v1/api/openplatform/coding_plan/remains", { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" }, config);
			if (out.guard) return out.guard;
			const body = out.body || {};
			const baseResp = body.base_resp && typeof body.base_resp === "object" ? body.base_resp : {};
			const statusCode = cpNum(baseResp.status_code, 0);
			if (statusCode !== 0) return cpError("API error (code " + statusCode + "): " + (baseResp.status_msg || "Unknown error"));
			const remains = Array.isArray(body.model_remains) ? body.model_remains : [];
			const general = remains.find((item) => item && String(item.model_name || "").toLowerCase() === "general") || null;
			if (!general) return cpOk([], null);
			const tiers = [];
			const fiveHourRemaining = cpNum(general.current_interval_remaining_percent, 0);
			tiers.push(cpTier(CP_TIER_FIVE_HOUR, Math.max(100 - fiveHourRemaining, 0), cpExtractResetTime(general.end_time)));
			const weeklyStatus = cpNum(general.current_weekly_status, 0);
			if (weeklyStatus === 1) {
				const weeklyRemaining = cpNum(general.current_weekly_remaining_percent, 0);
				tiers.push(cpTier(CP_TIER_WEEKLY, Math.max(100 - weeklyRemaining, 0), cpExtractResetTime(general.weekly_end_time)));
			}
			return cpOk(tiers, null);
		}

		// ---- ZenMux（query_zenmux）----
		function cpZenmuxTier(entry) {
			if (!entry || typeof entry !== "object") return null;
			const percent = parseNumber(entry.usage_percentage);
			const utilization = percent === null ? null : percent <= 1 ? percent * 100 : percent;
			return cpTier(CP_TIER_FIVE_HOUR, utilization === null ? 0 : utilization, cpExtractResetTime(entry.resets_at), entry.used_value_usd, entry.max_value_usd);
		}

		async function cpQueryZenmux(config, apiKey) {
			const baseUrl = String(config.baseUrl || "").trim().replace(/\/+$/, "");
			if (!baseUrl) return cpError("缺少 request 配置：ZenMux 需要填写用量查询地址");
			const out = await cpGetJson(baseUrl + "/api/usage", { Authorization: "Bearer " + apiKey, Accept: "application/json" }, config);
			if (out.guard) return out.guard;
			const body = out.body || {};
			if (body.success !== true) return cpError("API error: " + (typeof body.message === "string" && body.message ? body.message : "Unknown error"));
			const data = body.data && typeof body.data === "object" ? body.data : null;
			if (!data) return cpError("Missing 'data' field in response");
			const plan = data.plan && typeof data.plan === "object" ? data.plan : {};
			const planName = cpFirstString([plan.tier, data.account_status]);
			const tiers = [];
			const fiveHour = cpZenmuxTier(data.quota_5_hour);
			if (fiveHour) tiers.push(fiveHour);
			const weekly = cpZenmuxTier(data.quota_7_day);
			if (weekly) tiers.push(cpTier(CP_TIER_WEEKLY, weekly.utilization, weekly.resetsAt, weekly.usedValueUsd, weekly.maxValueUsd));
			return cpOk(tiers, planName || null);
		}

		// ---- OpenCode Go（query_opencode_go）----
		async function cpQueryOpencodeGo(config, apiKey) {
			const out = await cpGetJson("https://opencode.ai/zen/go/v1/usage", { Authorization: "Bearer " + apiKey, Accept: "application/json" }, config);
			if (out.status === 403) return cpNotFound("API key is valid but has no OpenCode Go subscription (HTTP 403)");
			if (out.guard) return out.guard;
			const body = out.body || {};
			const usage = body.usage && typeof body.usage === "object" ? body.usage : {};
			const windows = [[usage.rolling, CP_TIER_FIVE_HOUR], [usage.weekly, CP_TIER_WEEKLY], [usage.monthly, CP_TIER_MONTHLY]];
			const tiers = [];
			for (const [entry, name] of windows) {
				if (!entry || typeof entry !== "object") continue;
				const percent = parseNumber(entry.percent);
				if (percent === null) continue;
				const resetsAt = percent > 0 ? cpExtractResetTime(entry.resetsAt) : null;
				tiers.push(cpTier(name, percent, resetsAt));
			}
			if (!tiers.length) return cpError("Unexpected usage response shape");
			return cpOk(tiers, null);
		}

		// ---- Command Code（query_command_code：控制面固定在根域名，4 次串行 GET）----
		const COMMAND_CODE_API_BASE = "https://api.commandcode.ai";

		function cpCommandCodeUrl(path, params) {
			const pairs = [];
			for (const pair of params || []) {
				if (pair[1] === undefined || pair[1] === null || pair[1] === "") continue;
				pairs.push(encodeURIComponent(pair[0]) + "=" + encodeURIComponent(String(pair[1])));
			}
			return COMMAND_CODE_API_BASE + path + (pairs.length ? "?" + pairs.join("&") : "");
		}

		async function cpCommandCodeGet(path, params, config, apiKey) {
			const response = await cpRequest(cpCommandCodeUrl(path, params), { headers: { Authorization: "Bearer " + apiKey, Accept: "application/json" } }, config);
			if (response.status === 401) return { auth: true };
			const guard = cpGuard(response);
			if (guard) return { error: guard.error };
			return { body: response.body };
		}

		function cpCommandCodeWindow(entry, name) {
			if (!entry || typeof entry !== "object") return null;
			const used = parseNumber(entry.used);
			const cap = parseNumber(entry.cap);
			if (used === null || cap === null || cap <= 0) return null;
			return cpTier(name, (used / cap) * 100, cpExtractResetTime(entry.resetAt));
		}

		async function cpQueryCommandCode(config, apiKey) {
			const whoami = await cpCommandCodeGet("/alpha/whoami", [["limits", "1"]], config, apiKey);
			if (whoami.auth) return cpAuthError(401);
			if (whoami.error) return cpError(whoami.error);
			const org = whoami.body && whoami.body.org && typeof whoami.body.org === "object" ? whoami.body.org : null;
			const orgId = org && typeof org.id === "string" && org.id !== "" ? org.id : null;
			const orgParams = orgId ? [["orgId", orgId]] : [];
			const credits = await cpCommandCodeGet("/alpha/billing/credits", orgParams, config, apiKey);
			if (credits.auth) return cpAuthError(401);
			if (credits.error) return cpError(credits.error);
			const subscriptions = await cpCommandCodeGet("/alpha/billing/subscriptions", orgParams, config, apiKey);
			if (subscriptions.auth) return cpAuthError(401);
			if (subscriptions.error) return cpError(subscriptions.error);
			const subscription = subscriptions.body && subscriptions.body.data && typeof subscriptions.body.data === "object" ? subscriptions.body.data : null;
			const periodStart = subscription && typeof subscription.currentPeriodStart === "string" ? subscription.currentPeriodStart : null;
			const summaryParams = [];
			if (periodStart) summaryParams.push(["since", periodStart]);
			if (orgId) summaryParams.push(["orgId", orgId]);
			const summary = await cpCommandCodeGet("/alpha/usage/summary", summaryParams, config, apiKey);
			if (summary.auth) return cpAuthError(401);
			if (summary.error) return cpError(summary.error);
			const creditsBody = credits.body || {};
			const creditRoot = creditsBody.credits && typeof creditsBody.credits === "object" ? creditsBody.credits : null;
			if (!creditRoot) return cpError("Missing 'credits' field in response");
			const creditSum = Math.max(cpNum(creditRoot.monthlyCredits, 0), 0) + Math.max(cpNum(creditRoot.purchasedCredits, 0), 0) + Math.max(cpNum(creditRoot.freeCredits, 0), 0);
			const totalCost = parseNumber(summary.body && summary.body.totalCost);
			if (totalCost === null) return cpError("Missing 'totalCost' field in response");
			const spent = Math.max(totalCost, 0);
			const pool = spent + creditSum;
			const windowLimits = creditsBody.windowLimits && typeof creditsBody.windowLimits === "object" ? creditsBody.windowLimits : creditRoot.windowLimits && typeof creditRoot.windowLimits === "object" ? creditRoot.windowLimits : null;
			const tiers = [];
			if (windowLimits && windowLimits.limited === true) {
				const fiveHour = cpCommandCodeWindow(windowLimits.fiveHour, CP_TIER_FIVE_HOUR);
				if (fiveHour) tiers.push(fiveHour);
				const weekly = cpCommandCodeWindow(windowLimits.weekly, CP_TIER_WEEKLY);
				if (weekly) tiers.push(weekly);
			}
			tiers.push(cpTier(CP_TIER_MONTHLY, pool > 0 ? (spent / pool) * 100 : 0, subscription ? cpExtractResetTime(subscription.currentPeriodEnd) : null, spent, pool));
			const planId = cpFirstString([subscription && subscription.planId, creditRoot.planId]);
			return cpOk(tiers, planId || null);
		}

		// ---- 火山方舟（Volcengine 签名 + GetAFPUsage / GetCodingPlanUsage）----
		const VOLCENGINE_OPENAPI_HOST = "open.volcengineapi.com";
		const VOLCENGINE_API_VERSION = "2024-01-01";
		const VOLCENGINE_DEFAULT_REGION = "cn-beijing";
		const VOLCENGINE_SERVICE = "ark";
		const VOLCENGINE_CONTENT_TYPE = "application/json; charset=utf-8";
		const VOLCENGINE_SIGNED_HEADERS = "host;x-date;x-content-sha256;content-type";
		const VOLCENGINE_AKSK_HINT = "请确认 AccessKey ID / SecretAccessKey 正确，且账号有方舟用量查询（OpenAPI）权限";

		function cpRor(value, bits) {
			return ((value >>> bits) | (value << (32 - bits))) >>> 0;
		}

		const CP_SHA256_K = [
			0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
			0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
			0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
			0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
			0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
			0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
			0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
			0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
		];

		/** 纯 JS SHA-256（不依赖 crypto.subtle，浏览器/本地都能用）。 */
		function cpSha256(bytes) {
			const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
			const input = bytes && bytes.length ? bytes : new Uint8Array(0);
			const total = (((input.length + 8) >> 6) + 1) << 6;
			const padded = new Uint8Array(total);
			padded.set(input);
			padded[input.length] = 0x80;
			const view = new DataView(padded.buffer);
			const bits = input.length * 8;
			view.setUint32(total - 8, Math.floor(bits / 4294967296), false);
			view.setUint32(total - 4, bits >>> 0, false);
			const w = new Uint32Array(64);
			for (let offset = 0; offset < total; offset += 64) {
				for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4, false);
				for (let i = 16; i < 64; i += 1) {
					const s0 = cpRor(w[i - 15], 7) ^ cpRor(w[i - 15], 18) ^ (w[i - 15] >>> 3);
					const s1 = cpRor(w[i - 2], 17) ^ cpRor(w[i - 2], 19) ^ (w[i - 2] >>> 10);
					w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
				}
				let a = h[0];
				let b = h[1];
				let c = h[2];
				let d = h[3];
				let e = h[4];
				let f = h[5];
				let g = h[6];
				let hh = h[7];
				for (let i = 0; i < 64; i += 1) {
					const S1 = cpRor(e, 6) ^ cpRor(e, 11) ^ cpRor(e, 25);
					const ch = (e & f) ^ (~e & g);
					const temp1 = (hh + S1 + ch + CP_SHA256_K[i] + w[i]) >>> 0;
					const S0 = cpRor(a, 2) ^ cpRor(a, 13) ^ cpRor(a, 22);
					const maj = (a & b) ^ (a & c) ^ (b & c);
					const temp2 = (S0 + maj) >>> 0;
					hh = g;
					g = f;
					f = e;
					e = (d + temp1) >>> 0;
					d = c;
					c = b;
					b = a;
					a = (temp1 + temp2) >>> 0;
				}
				h[0] = (h[0] + a) >>> 0;
				h[1] = (h[1] + b) >>> 0;
				h[2] = (h[2] + c) >>> 0;
				h[3] = (h[3] + d) >>> 0;
				h[4] = (h[4] + e) >>> 0;
				h[5] = (h[5] + f) >>> 0;
				h[6] = (h[6] + g) >>> 0;
				h[7] = (h[7] + hh) >>> 0;
			}
			const out = new Uint8Array(32);
			const outView = new DataView(out.buffer);
			for (let i = 0; i < 8; i += 1) outView.setUint32(i * 4, h[i], false);
			return out;
		}

		function cpHmacSha256(key, message) {
			const messageBytes = message && message.length ? message : new Uint8Array(0);
			const rawKey = key && key.length ? key : new Uint8Array(0);
			const normalized = rawKey.length > 64 ? cpSha256(rawKey) : rawKey;
			const block = new Uint8Array(64);
			block.set(normalized);
			const inner = new Uint8Array(64 + messageBytes.length);
			const outer = new Uint8Array(64 + 32);
			for (let i = 0; i < 64; i += 1) {
				inner[i] = block[i] ^ 0x36;
				outer[i] = block[i] ^ 0x5c;
			}
			inner.set(messageBytes, 64);
			outer.set(cpSha256(inner), 64);
			return cpSha256(outer);
		}

		function cpUtf8(text) {
			const str = String(text === undefined || text === null ? "" : text);
			const out = [];
			for (let i = 0; i < str.length; i += 1) {
				let code = str.charCodeAt(i);
				if (code < 0x80) {
					out.push(code);
				} else if (code < 0x800) {
					out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
				} else if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length && str.charCodeAt(i + 1) >= 0xdc00 && str.charCodeAt(i + 1) <= 0xdfff) {
					code = 0x10000 + ((code - 0xd800) << 10) + (str.charCodeAt(i + 1) - 0xdc00);
					i += 1;
					out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
				} else if (code >= 0xd800 && code <= 0xdfff) {
					out.push(0xef, 0xbf, 0xbd);
				} else {
					out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
				}
			}
			return new Uint8Array(out);
		}

		function cpHex(bytes) {
			let text = "";
			for (let i = 0; i < bytes.length; i += 1) text += (bytes[i] + 0x100).toString(16).slice(1);
			return text;
		}

		function cpSha256Hex(text) {
			return cpHex(cpSha256(cpUtf8(text)));
		}

		/** 火山 RFC3986 百分号编码（encodeURIComponent 会漏掉 !'()*）。 */
		function cpVolPercentEncode(text) {
			return encodeURIComponent(String(text)).replace(/[!'()*]/g, (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase());
		}

		function cpVolRegion(baseUrl) {
			const parts = cpHost(baseUrl).split(".");
			for (const part of parts) {
				if (part.indexOf("cn-") === 0 || part.indexOf("ap-") === 0) return part;
			}
			return VOLCENGINE_DEFAULT_REGION;
		}

		function cpVolCanonicalQuery(action, region) {
			const params = [["Action", action], ["Region", region], ["Version", VOLCENGINE_API_VERSION]];
			params.sort((left, right) => {
				if (left[0] === right[0]) return left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0;
				return left[0] < right[0] ? -1 : 1;
			});
			return params.map((pair) => cpVolPercentEncode(pair[0]) + "=" + cpVolPercentEncode(pair[1])).join("&");
		}

		function cpVolStamp(date) {
			const at = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
			const pad = (value) => String(value).padStart(2, "0");
			const xDate = String(at.getUTCFullYear()) + pad(at.getUTCMonth() + 1) + pad(at.getUTCDate()) + "T" + pad(at.getUTCHours()) + pad(at.getUTCMinutes()) + pad(at.getUTCSeconds()) + "Z";
			return { xDate: xDate, shortDate: xDate.slice(0, 8) };
		}

		/** Volcengine OpenAPI V4 签名（date 可注入，便于用已知向量自测）。 */
		function cpVolSign(accessKeyId, secretAccessKey, region, canonicalQuery, payload, date) {
			const stamp = cpVolStamp(date);
			const payloadHash = cpHex(cpSha256(payload && payload.length ? payload : new Uint8Array(0)));
			const canonicalHeaders = "content-type:" + VOLCENGINE_CONTENT_TYPE + "\nhost:" + VOLCENGINE_OPENAPI_HOST + "\nx-content-sha256:" + payloadHash + "\nx-date:" + stamp.xDate + "\n";
			const canonicalRequest = ["POST", "/", canonicalQuery, canonicalHeaders, VOLCENGINE_SIGNED_HEADERS, payloadHash].join("\n");
			const scope = stamp.shortDate + "/" + region + "/" + VOLCENGINE_SERVICE + "/request";
			const stringToSign = ["HMAC-SHA256", stamp.xDate, scope, cpSha256Hex(canonicalRequest)].join("\n");
			const key = cpUtf8(secretAccessKey);
			const kDate = cpHmacSha256(key, cpUtf8(stamp.shortDate));
			const kRegion = cpHmacSha256(kDate, cpUtf8(region));
			const kService = cpHmacSha256(kRegion, cpUtf8(VOLCENGINE_SERVICE));
			const kSigning = cpHmacSha256(kService, cpUtf8("request"));
			const signature = cpHex(cpHmacSha256(kSigning, cpUtf8(stringToSign)));
			return {
				region: region,
				canonicalQuery: canonicalQuery,
				canonicalRequest: canonicalRequest,
				stringToSign: stringToSign,
				scope: scope,
				xDate: stamp.xDate,
				xContentSha: payloadHash,
				signature: signature,
				authorization: "HMAC-SHA256 Credential=" + accessKeyId + "/" + scope + ", SignedHeaders=" + VOLCENGINE_SIGNED_HEADERS + ", Signature=" + signature
			};
		}

		function cpVolResponseError(body) {
			if (!body || typeof body !== "object") return null;
			let error = null;
			if (body.ResponseMetadata && typeof body.ResponseMetadata === "object" && body.ResponseMetadata.Error && typeof body.ResponseMetadata.Error === "object") error = body.ResponseMetadata.Error;
			else if (body.Error && typeof body.Error === "object") error = body.Error;
			if (!error) return null;
			const code = typeof error.Code === "string" ? error.Code : "";
			const message = typeof error.Message === "string" ? error.Message : "";
			if (!code && !message) return null;
			return { code: code, message: message };
		}

		function cpVolIsAuthError(code) {
			const text = String(code || "").toLowerCase();
			return ["auth", "signature", "accessdenied", "denied", "unauthorized", "forbidden", "credential", "token"].some((item) => text.includes(item));
		}

		async function cpVolCall(config, region, accessKeyId, secretAccessKey, action) {
			const canonicalQuery = cpVolCanonicalQuery(action, region);
			const signed = cpVolSign(accessKeyId, secretAccessKey, region, canonicalQuery, new Uint8Array(0), new Date());
			const response = await cpRequest(
				"https://" + VOLCENGINE_OPENAPI_HOST + "/?" + canonicalQuery,
				{
					method: "POST",
					headers: { "X-Date": signed.xDate, "X-Content-Sha256": signed.xContentSha, "Content-Type": VOLCENGINE_CONTENT_TYPE, Authorization: signed.authorization },
					body: ""
				},
				config
			);
			if (response.status === 401 || response.status === 403) {
				return { kind: "auth", detail: "Authentication failed (HTTP " + response.status + "). " + VOLCENGINE_AKSK_HINT };
			}
			if (!response.ok) {
				const envelope = cpVolResponseError(response.body);
				if (envelope) {
					if (cpVolIsAuthError(envelope.code)) return { kind: "auth", detail: "Authentication failed (HTTP " + response.status + ", " + envelope.code + "): " + envelope.message + ". " + VOLCENGINE_AKSK_HINT };
					return { kind: "soft", detail: "API error (HTTP " + response.status + ", " + envelope.code + "): " + envelope.message };
				}
				return { kind: "soft", detail: "API error (HTTP " + response.status + "): " + preview(response.text) };
			}
			if (response.parseError) return { kind: "soft", detail: "Failed to parse response: " + response.parseError };
			const envelope = cpVolResponseError(response.body);
			if (envelope) {
				if (cpVolIsAuthError(envelope.code)) return { kind: "auth", detail: "Authentication failed (" + envelope.code + "): " + envelope.message + ". " + VOLCENGINE_AKSK_HINT };
				return { kind: "soft", detail: "API error (" + envelope.code + "): " + envelope.message };
			}
			return { kind: "body", body: response.body };
		}

		/** parse_afp_tiers：AFPFiveHour / AFPWeekly / AFPMonthly，Quota <= 0 视为未订阅（跳过）。 */
		function cpParseAfpTiers(result) {
			const windows = [["AFPFiveHour", CP_TIER_FIVE_HOUR], ["AFPWeekly", CP_TIER_WEEKLY], ["AFPMonthly", CP_TIER_MONTHLY]];
			const tiers = [];
			for (const [key, name] of windows) {
				const entry = result && typeof result === "object" ? result[key] : null;
				if (!entry || typeof entry !== "object") continue;
				const quota = cpNum(entry.Quota, 0);
				if (quota <= 0) continue;
				const used = cpNum(entry.Used, 0);
				tiers.push(cpTier(name, (used / quota) * 100, cpExtractResetTime(entry.ResetTime)));
			}
			return tiers;
		}

		function cpVolCodingWindow(label) {
			const text = String(label || "").toLowerCase();
			if (text === "session" || text === "5h" || text === "fivehour" || text === "five_hour" || text === "rolling_5h") return CP_TIER_FIVE_HOUR;
			if (text === "weekly" || text === "week" || text === "7d") return CP_TIER_WEEKLY;
			if (text === "monthly" || text === "month") return CP_TIER_MONTHLY;
			return null;
		}

		/** parse_coding_plan_tiers：QuotaUsage / Usages / Details，标签取 Level（实测）否则 Type/Period/Label/Window。 */
		function cpParseCodingPlanTiers(result) {
			let entries = null;
			if (result && typeof result === "object") {
				if (Array.isArray(result.QuotaUsage)) entries = result.QuotaUsage;
				else if (Array.isArray(result.Usages)) entries = result.Usages;
				else if (Array.isArray(result.Details)) entries = result.Details;
			}
			const tiers = [];
			for (const entry of entries || []) {
				if (!entry || typeof entry !== "object") continue;
				const name = cpVolCodingWindow(cpFirstString([entry.Level, entry.Type, entry.Period, entry.Label, entry.Window]));
				if (!name) continue;
				const percent = parseNumber(entry.Percent);
				const utilization = percent === null ? cpNum(entry.UsedPercent, cpNum(entry.UsagePercent, 0)) : percent;
				const reset = entry.ResetTime === undefined || entry.ResetTime === null ? entry.ResetTimestamp : entry.ResetTime;
				tiers.push(cpTier(name, utilization, cpExtractResetTime(reset)));
			}
			return tiers;
		}

		async function cpQueryVolcengine(config, accessKeyId, secretAccessKey) {
			const region = cpVolRegion(config.baseUrl);
			const softErrors = [];
			const first = await cpVolCall(config, region, accessKeyId, secretAccessKey, "GetAFPUsage");
			if (first.kind === "auth") return cpAuthDetail(first.detail);
			if (first.kind === "soft") softErrors.push("GetAFPUsage: " + first.detail);
			if (first.kind === "body") {
				const result = first.body && typeof first.body === "object" ? (first.body.Result && typeof first.body.Result === "object" ? first.body.Result : first.body) : null;
				const planType = result && typeof result.PlanType === "string" && result.PlanType.trim() !== "" ? result.PlanType.trim() : null;
				const tiers = result ? cpParseAfpTiers(result) : [];
				if (tiers.length) return cpOk(tiers, planType ? "Agent Plan " + planType : null);
			}
			const second = await cpVolCall(config, region, accessKeyId, secretAccessKey, "GetCodingPlanUsage");
			if (second.kind === "auth") return cpAuthDetail(second.detail);
			if (second.kind === "soft") softErrors.push("GetCodingPlanUsage: " + second.detail);
			if (second.kind === "body") {
				const result = second.body && typeof second.body === "object" ? (second.body.Result && typeof second.body.Result === "object" ? second.body.Result : second.body) : null;
				const tiers = result ? cpParseCodingPlanTiers(result) : [];
				if (tiers.length) return cpOk(tiers, "Coding Plan");
			}
			if (softErrors.length) return cpError(softErrors.join("; "));
			const raws = [];
			if (first.kind === "body") raws.push(preview(JSON.stringify(first.body)));
			if (second.kind === "body") raws.push(preview(JSON.stringify(second.body)));
			if (raws.length) return cpError("No active subscription found (signature OK). Raw: " + raws.join(" || "));
			return cpError("No active Agent Plan or Coding Plan subscription found for this credential");
		}

		/** 编程套餐查询的入口判定顺序。 */
		async function queryCodingPlan(provider, config) {
			const apiKey = String(config.accessToken || "").trim();
			if (provider === CP_MANUAL_ONLY) {
				const organizationId = String(config.organizationId || "").trim();
				const projectId = String(config.projectId || "").trim();
				if (!apiKey || !organizationId || !projectId) return cpToResult(cpNotFound("Zhipu team plan needs the API key + organization ID + project ID"));
				return cpToResult(await cpQueryZhipuTeam(config, apiKey, organizationId, projectId));
			}
			if (provider === "cp-volcengine") {
				const accessKeyId = String(config.accessKeyId || "").trim();
				const secretAccessKey = String(config.secretAccessKey || "").trim();
				if (!accessKeyId || !secretAccessKey) return cpToResult(cpNotFound("Volcengine usage query needs the account AccessKey ID + SecretAccessKey (not the inference API key)"));
				return cpToResult(await cpQueryVolcengine(config, accessKeyId, secretAccessKey));
			}
			if (!apiKey) return failResult("API key is empty");
			if (provider === "cp-kimi") return cpToResult(await cpQueryKimi(config, apiKey));
			if (provider === "cp-zhipu") return cpToResult(await cpQueryZhipu(config, apiKey));
			if (provider === "cp-minimax") return cpToResult(await cpQueryMinimax(config, apiKey, cpHostMatchesAny(cpHost(config.baseUrl), ["api.minimaxi.com", "api.minimax.cn"])));
			if (provider === "cp-zenmux") return cpToResult(await cpQueryZenmux(config, apiKey));
			if (provider === "cp-opencode-go") return cpToResult(await cpQueryOpencodeGo(config, apiKey));
			if (provider === "cp-command-code") return cpToResult(await cpQueryCommandCode(config, apiKey));
			return cpToResult(cpNotFound("Unknown coding plan provider"));
		}
		//#endregion

		//#region New API
		async function queryNewApi(config) {
			const base = String(config.baseUrl || "").replace(/\/+$/, "");
			if (!base) return failResult("未填写接口地址");
			if (!isHttpsOrLocal(base)) return failResult("接口地址必须是 HTTPS（本地地址除外）");
			const headers = { "Content-Type": "application/json", Authorization: "Bearer " + config.accessToken };
			if (config.userId) headers["New-Api-User"] = String(config.userId);
			const response = await httpSend({ url: base + "/api/user/self", method: "GET", headers: headers }, config.timeoutSeconds);
			if (response.status === 401 || response.status === 403) {
				return authFailResult("Authentication failed (HTTP " + response.status + ")");
			}
			if (!response.ok) {
				return failResult("HTTP " + response.status + " : " + preview(response.text));
			}
			let body = null;
			try {
				body = response.text ? JSON.parse(response.text) : {};
			} catch (error) {
				return failResult("Failed to parse response: " + String((error && error.message) || error));
			}
			if (!body || body.success !== true || !body.data) {
				const message = (body && (body.message || (body.error && body.error.message))) || "查询失败";
				// 返回一条 isValid:false 的记录，而不是硬错误。
				return invalidResult(message);
			}
			const data = body.data;
			const rate = clampNumber(config.quotaPerUnit, DEFAULT_CONFIG.quotaPerUnit, 1, 1e12);
			const quota = parseNumber(data.quota);
			const usedQuota = parseNumber(data.used_quota);
			if (quota === null && usedQuota === null) return failResult("Failed to parse response: 缺少字段 'quota'");
			const remaining = (quota === null ? 0 : quota) / rate;
			const used = (usedQuota === null ? 0 : usedQuota) / rate;
			const group = typeof data.group === "string" && data.group ? data.group : "默认套餐";
			return okResult([makeItem(group, remaining, remaining + used, used, config.unit, true, null, null)]);
		}
		//#endregion

		//#region 自定义用量脚本
		function isHttpsOrLocal(url) {
			const text = String(url || "");
			if (/^https:\/\//i.test(text)) return true;
			return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)([:/]|$)/i.test(text);
		}

		/** 把 {{apiKey}}/{{baseUrl}}/{{accessToken}}/{{userId}} 占位符替换成配置值。 */
		function buildScriptWithVars(code, config) {
			let script = String(code === undefined || code === null ? "" : code);
			const replacements = [
				["{{apiKey}}", config.accessToken],
				["{{baseUrl}}", String(config.baseUrl || "").replace(/\/+$/, "")],
				["{{accessToken}}", config.accessToken],
				["{{userId}}", config.userId]
			];
			for (const pair of replacements) {
				const value = pair[1];
				if (pair[0] === "{{apiKey}}" || pair[0] === "{{baseUrl}}") {
					script = script.split(pair[0]).join(String(value === undefined || value === null ? "" : value));
				} else if (value !== undefined && value !== null && value !== "") {
					script = script.split(pair[0]).join(String(value));
				}
			}
			return script;
		}

		function evaluateScript(script) {
			try {
				return { value: new Function("return (" + script + ");")() };
			} catch (error) {
				if (error && error.name === "SyntaxError") return { error: "脚本语法错误: " + String(error.message) };
				return { error: "脚本执行失败: " + String((error && error.message) || error) };
			}
		}

		function validateScriptItem(item, index) {
			const label = index === undefined ? "" : "第 " + (index + 1) + " 项：";
			if (!item || typeof item !== "object" || Array.isArray(item)) return label + "必须返回对象";
			const result = makeItem(
				typeof item.planName === "string" ? item.planName : null,
				parseNumber(item.remaining),
				parseNumber(item.total),
				parseNumber(item.used),
				typeof item.unit === "string" ? item.unit : null,
				item.isValid === undefined || item.isValid === null ? true : item.isValid,
				typeof item.invalidMessage === "string" ? item.invalidMessage : null,
				typeof item.extra === "string" ? item.extra : null
			);
			if (item.remaining !== undefined && item.remaining !== null && typeof item.remaining !== "number") {
				return label + "remaining 必须是数字或 null";
			}
			if (item.total !== undefined && item.total !== null && typeof item.total !== "number") {
				return label + "total 必须是数字或 null";
			}
			if (item.used !== undefined && item.used !== null && typeof item.used !== "number") {
				return label + "used 必须是数字或 null";
			}
			if (item.isValid !== undefined && item.isValid !== null && typeof item.isValid !== "boolean") {
				return label + "isValid 必须是布尔或 null";
			}
			if (item.invalidMessage !== undefined && item.invalidMessage !== null && typeof item.invalidMessage !== "string") {
				return label + "invalidMessage 必须是字符串或 null";
			}
			if (item.unit !== undefined && item.unit !== null && typeof item.unit !== "string") {
				return label + "unit 必须是字符串或 null";
			}
			if (item.planName !== undefined && item.planName !== null && typeof item.planName !== "string") {
				return label + "planName 必须是字符串或 null";
			}
			if (item.extra !== undefined && item.extra !== null && typeof item.extra !== "string") {
				return label + "extra 必须是字符串或 null";
			}
			return result;
		}

		async function queryScript(config) {
			if (!String(config.customScript || "").trim()) return failResult("尚未填写自定义脚本");
			const script = buildScriptWithVars(config.customScript, config);
			const evaluated = evaluateScript(script);
			if (evaluated.error) return failResult(evaluated.error);
			const scriptConfig = evaluated.value;
			if (!scriptConfig || typeof scriptConfig !== "object") return failResult("缺少 request 配置");
			const request = scriptConfig.request;
			if (!request || typeof request !== "object") return failResult("缺少 request 配置");
			const url = typeof request.url === "string" ? request.url.trim() : "";
			if (!url) return failResult("request.url 必须是非空字符串");
			if (!isHttpsOrLocal(url)) return failResult("request.url 必须是 HTTPS（本地地址除外）");
			const method = String(request.method || "GET").toUpperCase();
			const allowed = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
			if (allowed.indexOf(method) === -1) return failResult("不支持的请求方法 '" + method + "'");
			const headers = {};
			if (request.headers !== undefined && request.headers !== null) {
				if (typeof request.headers !== "object" || Array.isArray(request.headers)) return failResult("request.headers 必须是字符串到字符串的对象");
				for (const key of Object.keys(request.headers)) {
					const value = request.headers[key];
					if (typeof value !== "string") return failResult("request.headers['" + key + "'] 必须是字符串");
					headers[key] = value;
				}
			}
			let body;
			if (request.body !== undefined && request.body !== null) {
				body = typeof request.body === "string" ? request.body : JSON.stringify(request.body);
			}
			if (typeof scriptConfig.extractor !== "function") return failResult("缺少 extractor 函数");

			const response = await httpSend({ url: url, method: method, headers: headers, body: body }, config.timeoutSeconds);
			if (!response.ok) {
				return failResult("HTTP " + response.status + " : " + preview(response.text));
			}
			let parsed;
			try {
				parsed = response.text ? JSON.parse(response.text) : {};
			} catch (error) {
				parsed = response.text; // 解析失败就把纯文本交给 extractor
			}
			let extracted;
			try {
				extracted = scriptConfig.extractor(parsed);
			} catch (error) {
				return failResult("extractor 执行失败: " + String((error && error.message) || error));
			}
			if (extracted === undefined || extracted === null) return failResult("extractor 必须返回对象或对象数组");
			// 数字 / 字符串 / 布尔等原始值不是合法结果。
			if (typeof extracted !== "object") return failResult("extractor 必须返回对象或对象数组");
			if (Array.isArray(extracted)) {
				if (!extracted.length) return failResult("脚本返回的数组不能为空");
				const items = [];
				for (let index = 0; index < extracted.length; index += 1) {
					const validated = validateScriptItem(extracted[index], index);
					if (typeof validated === "string") return failResult(validated);
					items.push(validated);
				}
				return okResult(items);
			}
			const validated = validateScriptItem(extracted);
			if (typeof validated === "string") return failResult(validated);
			return okResult([validated]);
		}
		//#endregion

		//#region 查询入口（分发 + 瞬时失败重试一次）
		async function queryOnce(config) {
			const provider = resolveProvider(config);
			if (provider === "custom") return queryScript(config);
			if (isCodingPlanProvider(provider)) return queryCodingPlan(provider, config);
			if (provider === "newapi") {
				if (!config.baseUrl) return failResult("Endpoint is empty");
				return queryNewApi(config);
			}
			if (NATIVE_PROVIDERS[provider]) {
				if (!config.accessToken) return failResult("API key is empty");
				return queryNative(provider, config, { Authorization: "Bearer " + config.accessToken });
			}
			return failResult("Unknown balance provider");
		}

		async function queryQuota(config) {
			try {
				return await queryOnce(config);
			} catch (error) {
				if (!error || !error.transient) throw error;
				// 只对传输层失败重试一次。
				await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
				return await queryOnce(config);
			}
		}
		//#endregion

		//#region 展示规则
		function isTierItem(item) {
			// unit 为 % 的按档额度才做「快用完」预警；余额（￥/$）不做预警。
			return String((item && item.unit) || "") === "%";
		}

		function leftPercentOf(item) {
			if (!item || typeof item.remaining !== "number") return null;
			if (item.remaining <= 0) return 0;
			if (typeof item.total === "number" && item.total > 0) return (item.remaining / item.total) * 100;
			return null;
		}

		function toneForLeft(left) {
			if (left === null || left === undefined) return "normal";
			if (left <= 0) return "danger";
			if (left < WARN_BELOW_PERCENT) return "warning";
			return "normal";
		}

		function primaryItem(plans) {
			if (!plans || !plans.length) return null;
			const withValue = plans.find((item) => item && typeof item.remaining === "number");
			return withValue || plans[0];
		}

		function plansPercent(plans) {
			const item = primaryItem(plans);
			return leftPercentOf(item);
		}
		//#endregion

		//#region store（含 keep-last-good）
		function createStore() {
			const listeners = new Set();
			const initialConfig = loadConfig();
			const initialSnapshot = loadCachedSnapshot();
			let state = {
				config: initialConfig,
				phase: initialConfig.accessToken ? "idle" : "unconfigured",
				plans: null,
				error: "",
				queriedAt: 0,
				lastGoodAt: initialSnapshot ? initialSnapshot.at : 0,
				stale: false,
				lastGood: initialSnapshot
			};
			if (initialSnapshot) {
				state = Object.assign({}, state, {
					plans: initialSnapshot.data.data,
					stale: Date.now() - initialSnapshot.at >= KEEP_LAST_GOOD_MS,
					phase: initialConfig.accessToken ? "idle" : "unconfigured"
				});
			}
			let timer = 0;
			let retryTimer = 0;
			let inFlight = false;

			const emit = () => {
				for (const listener of Array.from(listeners)) {
					try {
						listener();
					} catch (error) {
						// 单个订阅者出错不影响其它订阅者
					}
				}
			};

			const patch = (changes) => {
				state = Object.assign({}, state, changes);
				emit();
			};

			const intervalMs = () => {
				const minutes = clampNumber(state.config.autoQueryInterval, 0, 0, MAX_INTERVAL_MINUTES);
				return minutes > 0 ? minutes * 60 * 1000 : 0;
			};

			const arm = () => {
				if (timer) clearTimeout(timer);
				timer = 0;
				const wait = intervalMs();
				if (!wait) return;
				timer = setTimeout(() => {
					refresh();
				}, wait);
			};

			const onVisibility = () => {
				if (document.visibilityState !== "visible") return;
				const wait = intervalMs();
				if (!wait) return;
				const reference = state.queriedAt || state.lastGoodAt;
				if (!reference || Date.now() - reference >= wait) refresh();
			};

			/**
			 * 结果如何落到界面上：
			 * - 成功 → 刷新 lastGood 快照；
			 * - 确定性失败 → 立即透出，并清空快照（旧额度不可信）；
			 * - 瞬时失败 → 10 分钟窗口内继续展示上次成功值（stale=true）。
			 */
			function applyResult(result, at) {
				let lastGood = state.lastGood;
				if (result && result.success) {
					lastGood = { data: result, at: at };
					persistSnapshot(Object.assign({}, lastGood, { config: pickConfigSummary(state.config) }));
				} else if (result && !result.success && !isTransientResult(result)) {
					lastGood = null;
					persistSnapshot(null);
				}
				let display = result;
				let stale = false;
				let lastGoodAt = lastGood ? lastGood.at : at;
				if (result && !result.success && isTransientResult(result) && lastGood && at - lastGood.at < KEEP_LAST_GOOD_MS) {
					display = lastGood.data;
					stale = true;
					lastGoodAt = lastGood.at;
				}
				const invalid = display && display.success && hasInvalidItem(display);
				const error = result && result.success ? invalid ? firstInvalidMessage(result) : "" : String((result && result.error) || "");
				patch({
					phase: "ready",
					plans: display ? display.data : null,
					error: error,
					queriedAt: at,
					lastGoodAt: lastGoodAt,
					stale: stale,
					lastGood: lastGood
				});
			}

			function pickConfigSummary(config) {
				return { provider: config.provider, baseUrl: config.baseUrl };
			}

			async function refresh() {
				if (timer) clearTimeout(timer);
				if (retryTimer) {
					clearTimeout(retryTimer);
					retryTimer = 0;
				}
				if (inFlight) {
					arm();
					return state;
				}
				const config = state.config;
				const provider = resolveProvider(config);
				if (provider === "newapi" && !config.baseUrl) {
					// 没填接口地址就不发请求（否则会打到 DSH 自己的源）
					patch({ phase: "unconfigured", error: "" });
					arm();
					return state;
				}
				if (!config.accessToken && provider !== "custom") {
					patch({ phase: "unconfigured", error: "" });
					arm();
					return state;
				}
				if (!config.accessToken && provider === "custom") {
					patch({ phase: "unconfigured", error: "" });
					arm();
					return state;
				}
				inFlight = true;
				patch({ phase: "refreshing" });
				try {
					const result = await queryQuota(config);
					applyResult(result, Date.now());
				} catch (error) {
					const message = describeError(error, config.baseUrl);
					const transient = Boolean(error && error.transient) || isTransientMessage(message);
					const lastGood = state.lastGood;
					if (transient && lastGood && Date.now() - lastGood.at < KEEP_LAST_GOOD_MS) {
						patch({ phase: "ready", plans: lastGood.data.data, error: message, queriedAt: Date.now(), stale: true });
					} else {
						if (!transient) {
							state = Object.assign({}, state, { lastGood: null });
							persistSnapshot(null);
						}
						// 超过保留窗口（或没有上次成功值）时不再展示旧额度，只显示失败。
						patch({ phase: "error", plans: null, error: message, queriedAt: Date.now(), stale: false });
					}
				} finally {
					inFlight = false;
					arm();
				}
				return state;
			}

			return {
				subscribe(listener) {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				getState() {
					return state;
				},
				getConfig() {
					return state.config;
				},
				saveConfig(changes) {
					const config = normalizeConfig(Object.assign({}, state.config, changes));
					persistConfig(config);
					patch({ config: config });
					const result = refresh();
					return result;
				},
				resetConfig() {
					const config = normalizeConfig(null);
					persistConfig(config);
					persistSnapshot(null);
					patch({ config: config, phase: "idle", plans: null, error: "", queriedAt: 0, lastGoodAt: 0, stale: false, lastGood: null });
					const result = refresh();
					return result;
				},
				refresh,
				start() {
					if (state.config.accessToken || resolveProvider(state.config) === "custom") refresh();
					else {
						patch({ phase: "unconfigured", error: "" });
						arm();
					}
					if (typeof document !== "undefined" && document.addEventListener) {
						document.addEventListener("visibilitychange", onVisibility);
					}
					return () => {
						if (timer) clearTimeout(timer);
						timer = 0;
						if (retryTimer) clearTimeout(retryTimer);
						retryTimer = 0;
						if (typeof document !== "undefined" && document.removeEventListener) {
							document.removeEventListener("visibilitychange", onVisibility);
						}
					};
				}
			};
		}
		//#endregion

		//#region 样式（与 dsh-context 的「上下文洞察」行同款几何）
		const CSS = `
.dsh-balance-inquiry-entry{box-sizing:border-box;width:calc(100% + 4px);height:42px;color:var(--dsw-alias-label-primary,#e6e6e6);cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:8px;margin:0 -2px;padding:0 10px 0 8px;font-family:inherit;font-size:14px;line-height:22px;display:flex;overflow:hidden;text-decoration:none}
.dsh-balance-inquiry-entry:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.dsh-balance-inquiry-entry-rail{border-radius:50%;flex:none;justify-content:center;gap:0;width:36px;height:36px;margin:0;padding:0}
.dsh-balance-inquiry-entry-icon{flex:none}
.dsh-balance-inquiry-entry-label{text-align:left;white-space:nowrap;text-overflow:ellipsis;flex:auto;min-width:0;overflow:hidden}
.dsh-balance-inquiry-entry-error{color:var(--dsw-alias-state-error-primary,#e5534b)}
.dsh-balance-inquiry-entry-warning{color:var(--dsw-alias-state-warn-primary,#d29922)}
.dsh-balance-inquiry-page{display:flex;flex-direction:column;gap:16px;padding:2px 0 10px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsh-balance-inquiry-title{margin:0;font-size:15px;font-weight:600}
.dsh-balance-inquiry-desc{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#8b8b8b)}
.dsh-balance-inquiry-field{display:flex;flex-direction:column;gap:6px}
.dsh-balance-inquiry-field-label{font-size:12px;color:var(--dsw-alias-label-secondary,#8b8b8b)}
.dsh-balance-inquiry-input{box-sizing:border-box;width:100%;height:32px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.04));color:inherit;padding:0 10px;font-family:inherit;font-size:13px;outline:none}
.dsh-balance-inquiry-input:focus{border-color:var(--dsw-alias-brand-primary,#4d6bfe)}
.dsh-balance-inquiry-textarea{box-sizing:border-box;width:100%;min-height:150px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.04));color:inherit;padding:8px 10px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:18px;outline:none;resize:vertical}
.dsh-balance-inquiry-textarea:focus{border-color:var(--dsw-alias-brand-primary,#4d6bfe)}
.dsh-balance-inquiry-hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#8b8b8b)}
.dsh-balance-inquiry-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dsh-balance-inquiry-check{display:flex;gap:6px;align-items:center;font-size:12px;color:var(--dsw-alias-label-secondary,#8b8b8b);cursor:pointer}
.dsh-balance-inquiry-btn{box-sizing:border-box;height:32px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));background:0 0;color:inherit;padding:0 14px;font-family:inherit;font-size:13px;cursor:pointer}
.dsh-balance-inquiry-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
/* 主按钮：底色取「正文色」、文字取「底面底色」——这两个令牌在明/暗皮肤里互为反差，
   深色皮肤得到白底深字、浅色皮肤得到深底浅字，任何皮肤都不会出现白底白字。
   （原先用 brand-primary 作底 + 固定 #fff 字，遇到把 brand-primary 定义成白色的皮肤就会隐形。） */
.dsh-balance-inquiry-btn-primary{background:var(--dsw-alias-label-primary,#fff);border-color:transparent;color:var(--dsw-alias-bg-base,#17181c)}
.dsh-balance-inquiry-btn-primary:hover{background:var(--dsw-alias-label-primary,#fff);opacity:.88}
.dsh-balance-inquiry-status{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#8b8b8b)}
.dsh-balance-inquiry-status-ok{color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsh-balance-inquiry-status-error{color:var(--dsw-alias-state-error-primary,#e5534b)}
.dsh-balance-inquiry-plans{display:flex;flex-direction:column;gap:4px}
.dsh-balance-inquiry-plan{display:flex;gap:8px;align-items:baseline;font-size:12px;line-height:18px}
.dsh-balance-inquiry-plan-name{color:var(--dsw-alias-label-secondary,#8b8b8b);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-balance-inquiry-plan-value{color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsh-balance-inquiry-warning .dsh-balance-inquiry-plan-value{color:var(--dsw-alias-state-warn-primary,#d29922)}
.dsh-balance-inquiry-danger .dsh-balance-inquiry-plan-value{color:var(--dsw-alias-state-error-primary,#e5534b)}
.dsh-balance-inquiry-muted{color:var(--dsw-alias-label-secondary,#8b8b8b)}
.dsh-balance-inquiry-sep{height:1px;background:var(--dsw-alias-border-l1,rgba(255,255,255,.08))}
`;

		function installStyles() {
			if (typeof document === "undefined") return;
			if (document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG_ID) + "]") !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-balance-inquiry";
			tag.dataset.pluginCss = CSS_TAG_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}
		//#endregion

		function openExternal(url) {
			if (!url) return;
			const target = String(url);
			try {
				window.open(target, "_blank", "noopener,noreferrer");
			} catch (error) {
				try {
					window.location.assign(target);
				} catch (innerError) {
					// 无能为力，忽略
				}
			}
		}

		function QuotaIcon(props) {
			const size = props && props.size ? props.size : 16;
			return h(
				"svg",
				{
					className: props && props.className,
					width: size,
					height: size,
					viewBox: "0 0 16 16",
					fill: "none",
					"aria-hidden": "true",
					focusable: "false"
				},
				h("path", {
					d: "M2.2 5.2c0-.8.6-1.4 1.4-1.4h7.6c.5 0 .9.4.9.9v1.1",
					stroke: "currentColor",
					strokeWidth: 1,
					strokeLinecap: "round",
					strokeLinejoin: "round"
				}),
				h("rect", {
					x: "2.2",
					y: "4.6",
					width: "11.6",
					height: "7.6",
					rx: "1.6",
					stroke: "currentColor",
					strokeWidth: 1
				}),
				h("path", {
					d: "M10.6 8.4h2.5",
					stroke: "currentColor",
					strokeWidth: 1.2,
					strokeLinecap: "round"
				})
			);
		}

		//#region 组件
		function createComponents(store, t) {
			const useQuotaState = React.useSyncExternalStore
				? () => React.useSyncExternalStore(store.subscribe, store.getState)
				: () => {
						const pair = React.useState(0);
						const force = pair[1];
						React.useEffect(() => store.subscribe(() => force((value) => value + 1)), []);
						return store.getState();
					};

			/** 余额 {value} / 余额已用完 */
			function balanceText(item) {
				if (!item || typeof item.remaining !== "number") return "";
				if (item.remaining <= 0) return t("entry.tip.danger");
				const value = formatValue(item.remaining, item.unit);
				if (item.planName) return format(t("entry.tip.balance"), { plan: item.planName, value: value });
				return format(t("entry.tip.balance.noplan"), { value: value });
			}

			function entryLabel(state) {
				try {
					const item = primaryItem(state.plans);
					if (item && typeof item.remaining === "number") {
						return format(t("entry.value"), {
							amount: formatMoney(item.remaining),
							unit: unitSymbol(item.unit) || unitSymbol(state.config.unit)
						});
					}
					if (state.phase === "loading" || state.phase === "refreshing") return t("entry.loading");
					if (state.phase === "unconfigured") return t("entry.unconfigured");
					return t("entry.idle");
				} catch (error) {
					return t("entry.error");
				}
			}

			function entryTitle(state) {
				const now = Date.now();
				const lines = [t("entry.tip")];
				if (state.plans && state.plans.length) {
					const item = primaryItem(state.plans);
					const text = balanceText(item);
					if (text) lines.push(text);
					if (item && typeof item.used === "number") {
						if (typeof item.total === "number" && item.total > 0) {
							lines.push(
								format(t("entry.tip.usage"), {
									used: formatValue(item.used, item.unit),
									total: formatValue(item.total, item.unit),
									percent: formatMoney(leftPercentOf(item))
								})
							);
						} else {
							lines.push(format(t("entry.tip.used.only"), { used: formatValue(item.used, item.unit) }));
						}
					}
					if (item && typeof item.extra === "string" && item.extra) lines.push(format(t("entry.tip.resets"), { time: item.extra }));
					if (state.plans.length > 1) lines.push(format(t("entry.tip.more"), { count: state.plans.length - 1 }));
					for (const item of state.plans) {
						if (item && item.isValid === false && item.invalidMessage) {
							lines.push(format(t("entry.tip.invalid"), { message: item.invalidMessage }));
						}
					}
					if (state.lastGoodAt) {
						lines.push(
							format(t(state.stale ? "entry.tip.stale" : "entry.tip.updated"), {
								time: formatTime(state.lastGoodAt),
								ago: formatRelativeTime(state.lastGoodAt, now)
							})
						);
					}
				}
				if (state.phase === "unconfigured") lines.push(t("entry.tip.unconfigured"));
				if (state.error) {
					lines.push(t("entry.tip.failed"));
					lines.push(format(t("entry.tip.reason"), { message: state.error }));
				}
				return lines.filter(Boolean).join("\n");
			}

			/** 侧边栏行的颜色：余额只在 remaining<=0 时变红；查不到额度也是红的。 */
			function entryTone(state) {
				const item = primaryItem(state.plans);
				if (item && typeof item.remaining === "number") {
					if (item.remaining <= 0) return "danger";
					if (isTierItem(item)) return toneForLeft(leftPercentOf(item));
					return "normal";
				}
				if (state.error) return "danger";
				return "normal";
			}

			function QuotaEntry(props) {
				const state = useQuotaState();
				const wide = props && props.wide === true;
				const href = state.config.websiteUrl || state.config.baseUrl || "";
				const label = entryLabel(state);
				const title = entryTitle(state);
				const base = wide ? "dsh-balance-inquiry-entry" : "dsh-balance-inquiry-entry dsh-balance-inquiry-entry-rail";
				const tone = entryTone(state);
				const className =
					tone === "danger"
						? base + " dsh-balance-inquiry-entry-error"
						: tone === "warning"
							? base + " dsh-balance-inquiry-entry-warning"
							: base;
				return h(
					"a",
					{
						className: className,
						href: href || "#",
						target: "_blank",
						rel: "noreferrer noopener",
						title: title,
						"aria-label": label,
						onClick: (event) => {
							try {
								event.preventDefault();
							} catch (error) {
								// 忽略
							}
							if (href) openExternal(href);
							const result = store.refresh();
							if (result && typeof result.catch === "function") result.catch(() => {});
						}
					},
					h(QuotaIcon, { size: wide ? 16 : 18, className: "dsh-balance-inquiry-entry-icon" }),
					wide ? h("span", { className: "dsh-balance-inquiry-entry-label" }, label) : null
				);
			}

			function SettingsPage() {
				const state = useQuotaState();
				const staged = React.useState(null);
				const draft = staged[0];
				const setDraft = staged[1];
				const showSecretPair = React.useState(false);
				const showSecret = showSecretPair[0];
				const setShowSecret = showSecretPair[1];
				const noticePair = React.useState("");
				const notice = noticePair[0];
				const setNotice = noticePair[1];
				React.useEffect(() => {
					setDraft(null);
				}, [state.config]);
				const config = draft || state.config;
				const provider = resolveProvider(config);
				const isNative = Boolean(NATIVE_PROVIDERS[provider]);
				const isCustom = provider === "custom";
				const isNewApiLike = provider === "newapi";
				const isCodingPlan = isCodingPlanProvider(provider);
				const set = (key, value) => setDraft(Object.assign({}, config, { [key]: value }));

				const field = (key, label, options) => {
					const opts = options || {};
					return h(
						"label",
						{ className: "dsh-balance-inquiry-field", key: key },
						h("span", { className: "dsh-balance-inquiry-field-label" }, label),
						h("input", {
							className: "dsh-balance-inquiry-input",
							type: opts.secret && !showSecret ? "password" : opts.type || "text",
							value: config[key] === undefined || config[key] === null ? "" : String(config[key]),
							placeholder: opts.placeholder || "",
							spellCheck: false,
							autoComplete: "off",
							onChange: (event) => set(key, event.target.value)
						}),
						opts.hint ? h("span", { className: "dsh-balance-inquiry-hint" }, opts.hint) : null
					);
				};

				const select = (key, label, options, hint) =>
					h(
						"label",
						{ className: "dsh-balance-inquiry-field", key: key },
						h("span", { className: "dsh-balance-inquiry-field-label" }, label),
						h(
							"select",
							{
								className: "dsh-balance-inquiry-input",
								value: config[key],
								onChange: (event) => set(key, event.target.value)
							},
							options.map((item) => h("option", { key: item.id, value: item.id }, item.label))
						),
						hint ? h("span", { className: "dsh-balance-inquiry-hint" }, hint) : null
					);

				const save = () => {
					const result = store.saveConfig({
						provider: config.provider,
						baseUrl: config.baseUrl,
						accessToken: config.accessToken,
						userId: config.userId,
						organizationId: config.organizationId,
						projectId: config.projectId,
						accessKeyId: config.accessKeyId,
						secretAccessKey: config.secretAccessKey,
						websiteUrl: config.websiteUrl,
						autoQueryInterval: config.autoQueryInterval,
						timeoutSeconds: config.timeoutSeconds,
						quotaPerUnit: config.quotaPerUnit,
						unit: config.unit,
						customScript: config.customScript
					});
					setDraft(null);
					setNotice(t("settings.saved"));
					if (result && typeof result.catch === "function") result.catch(() => {});
				};

				/** 余额行的完整形态：一条记录一行。 */
				const planLines = () => {
					if (!state.plans || !state.plans.length) return null;
					return h(
						"div",
						{ className: "dsh-balance-inquiry-plans" },
						h("div", { className: "dsh-balance-inquiry-status" }, format(t("settings.plans"), { count: state.plans.length })),
						state.plans.map((item, index) => {
							const tone = item.isValid === false ? "danger" : isTierItem(item) ? toneForLeft(leftPercentOf(item)) : toneForLeft(item.remaining <= 0 ? 0 : null);
							const detail = [];
							if (typeof item.remaining === "number") detail.push(formatValue(item.remaining, item.unit));
							if (typeof item.used === "number") detail.push("已用 " + formatValue(item.used, item.unit));
							if (typeof item.total === "number" && item.total > 0) detail.push("总额 " + formatValue(item.total, item.unit));
							const percent = leftPercentOf(item);
							if (percent !== null) detail.push("剩余 " + formatMoney(percent) + "%");
							if (typeof item.extra === "string" && item.extra) detail.push(format(t("settings.resets"), { time: item.extra }));
							return h(
								"div",
								{ className: "dsh-balance-inquiry-plan dsh-balance-inquiry-" + tone, key: index },
								h("span", { className: "dsh-balance-inquiry-plan-name" }, item.planName || "—"),
								h("span", { className: "dsh-balance-inquiry-plan-value" }, detail.join(" ｜ "))
							);
						}),
						state.plans.some((item) => item && item.isValid === false && item.invalidMessage)
							? h(
									"div",
									{ className: "dsh-balance-inquiry-status dsh-balance-inquiry-status-error" },
									format(t("settings.status.invalid"), {
										message: firstInvalidMessage({ data: state.plans })
									})
								)
							: null
					);
				};

				/** 查询通道：宿主进程代理（无 CORS）还是浏览器直连（要求目标站允许跨域）。 */
				const transportText = () => {
					const mode = PROXY_STATE.mode;
					if (mode === "host") return t("settings.transport.host");
					if (mode === "browser") return t("settings.transport.browser");
					return t("settings.transport.unknown");
				};

				const statusText = () => {
					if (state.phase === "loading") return t("settings.status.loading");
					if (state.phase === "unconfigured") {
						// 出厂不预设站点：分清「没填地址」和「没填令牌」，避免用户找不到原因
						if (resolveProvider(state.config) === "newapi" && !state.config.baseUrl) return t("settings.status.unconfigured.endpoint");
						return t("settings.status.unconfigured");
					}
					const item = primaryItem(state.plans);
					const hasValue = Boolean(item && typeof item.remaining === "number");
					// 查不到额度（鉴权失败、success:false、HTTP 错误…）时，状态行必须给出原因，不能显示「尚未查询」。
					if (!hasValue) {
						if (state.error) {
							const detail = format(t("settings.status.error"), { message: errorTextOf(state) });
							if (state.lastGoodAt && Date.now() - state.lastGoodAt < KEEP_LAST_GOOD_MS) {
								return (
									detail +
									"（" +
									format(t("settings.status.updated"), {
										time: formatTime(state.lastGoodAt),
										ago: formatRelativeTime(state.lastGoodAt)
									}) +
									"）"
								);
							}
							return detail;
						}
						if (state.phase === "refreshing") return t("settings.status.loading");
						return t("settings.status.idle");
					}
					if (item && typeof item.remaining === "number") {
						const percent = leftPercentOf(item);
						const base =
							typeof item.total === "number" && item.total > 0
								? format(t("settings.status.ready"), {
										amount: formatValue(item.remaining, item.unit),
										used: formatValue(item.used === null ? 0 : item.used, item.unit),
										total: formatValue(item.total, item.unit),
										percent: formatMoney(percent === null ? 0 : percent)
									})
								: format(t("settings.status.ready.short"), { amount: formatValue(item.remaining, item.unit) });
						const parts = [base];
						if (state.stale) parts.push(t("settings.status.stale"));
						if (state.error) parts.push(format(t("settings.status.error"), { message: state.error }));
						if (state.lastGoodAt) {
							parts.push(
								format(t("settings.status.updated"), {
									time: formatTime(state.lastGoodAt),
									ago: formatRelativeTime(state.lastGoodAt)
								})
							);
						}
						return parts.join(" ｜ ");
					}
					if (state.phase === "refreshing") return t("settings.status.loading");
					return t("settings.status.idle");
				};

				const statusClass =
					state.phase === "error" && !(state.plans && state.plans.length)
						? "dsh-balance-inquiry-status dsh-balance-inquiry-status-error"
						: state.error
							? "dsh-balance-inquiry-status dsh-balance-inquiry-status-error"
							: "dsh-balance-inquiry-status";

				return h(
					"div",
					{ className: "dsh-balance-inquiry-page" },
					h("h2", { className: "dsh-balance-inquiry-title" }, t("settings.title")),
					h("p", { className: "dsh-balance-inquiry-desc" }, t("settings.hint")),
					select("provider", t("settings.provider"), PROVIDER_OPTIONS, t("settings.provider.hint")),
					isNative ? null : field("baseUrl", t("settings.baseUrl"), { placeholder: "https://api.example.com", hint: t("settings.baseUrl.hint") }),
					field("accessToken", t("settings.token"), { secret: true, hint: t("settings.token.hint") }),
					h(
						"div",
						{ className: "dsh-balance-inquiry-row" },
						h(
							"label",
							{ className: "dsh-balance-inquiry-check" },
							h("input", {
								type: "checkbox",
								checked: showSecret,
								onChange: (event) => setShowSecret(event.target.checked)
							}),
							t("settings.showToken")
						)
					),
					isNewApiLike || isCustom ? field("userId", t("settings.userId"), { hint: t("settings.userId.hint") }) : null,
					provider === "cp-zhipu-team" ? field("organizationId", t("settings.teamOrg"), { hint: t("settings.teamOrg.hint") }) : null,
					provider === "cp-zhipu-team" ? field("projectId", t("settings.teamProject"), { hint: t("settings.teamProject.hint") }) : null,
					provider === "cp-volcengine" ? field("accessKeyId", t("settings.accessKeyId"), { hint: t("settings.accessKeyId.hint") }) : null,
					provider === "cp-volcengine" ? field("secretAccessKey", t("settings.secretAccessKey"), { secret: true, hint: t("settings.secretAccessKey.hint") }) : null,
					isCodingPlan ? h("p", { className: "dsh-balance-inquiry-desc" }, t("settings.cp.hint")) : null,
					field("websiteUrl", t("settings.website"), { placeholder: config.baseUrl || "https://api.example.com", hint: t("settings.website.hint") }),
					field("autoQueryInterval", t("settings.interval"), { type: "number", hint: t("settings.interval.hint") }),
					field("timeoutSeconds", t("settings.timeout"), { type: "number", hint: t("settings.timeout.hint") }),
					isNewApiLike ? field("quotaPerUnit", t("settings.unit"), { type: "number", hint: t("settings.unit.hint") }) : null,
					isNewApiLike ? field("unit", t("settings.currency"), { hint: t("settings.currency.hint") }) : null,
					isCustom
						? h(
								"label",
								{ className: "dsh-balance-inquiry-field" },
								h("span", { className: "dsh-balance-inquiry-field-label" }, t("settings.script")),
								h("textarea", {
									className: "dsh-balance-inquiry-textarea",
									value: String(config.customScript || ""),
									spellCheck: false,
									rows: 10,
									onChange: (event) => set("customScript", event.target.value)
								}),
								h("span", { className: "dsh-balance-inquiry-hint" }, t("settings.script.hint")),
								h(
									"div",
									{ className: "dsh-balance-inquiry-row" },
									h(
										"button",
										{
											type: "button",
											className: "dsh-balance-inquiry-btn",
											onClick: () => set("customScript", NEW_API_TEMPLATE.split("{{rate}}").join(String(clampNumber(config.quotaPerUnit, DEFAULT_CONFIG.quotaPerUnit, 1, 1e12))))
										},
										t("settings.script.fillNewApi")
									),
									h(
										"button",
										{ type: "button", className: "dsh-balance-inquiry-btn", onClick: () => set("customScript", GENERIC_TEMPLATE) },
										t("settings.script.fillGeneric")
									)
								)
							)
						: null,
					h("div", { className: "dsh-balance-inquiry-sep" }),
					h(
						"div",
						{ className: "dsh-balance-inquiry-row" },
						h(
							"button",
							{ type: "button", className: "dsh-balance-inquiry-btn dsh-balance-inquiry-btn-primary", onClick: save },
							t("settings.save")
						),
						h(
							"button",
							{
								type: "button",
								className: "dsh-balance-inquiry-btn",
								onClick: () => {
									const result = store.refresh();
									if (result && typeof result.catch === "function") result.catch(() => {});
								}
							},
							t("settings.queryNow")
						),
						h(
							"button",
							{
								type: "button",
								className: "dsh-balance-inquiry-btn",
								onClick: () => openExternal(config.websiteUrl || config.baseUrl)
							},
							t("settings.openSite")
						),
						h(
							"button",
							{
								type: "button",
								className: "dsh-balance-inquiry-btn",
								onClick: () => {
									store.resetConfig();
									setDraft(null);
								}
							},
							t("settings.reset")
						)
					),
					h("div", { className: statusClass }, (notice ? notice + " ｜ " : "") + statusText()),
					h("div", { className: "dsh-balance-inquiry-hint" }, transportText()),
					planLines()
				);
			}

			return { QuotaEntry: QuotaEntry, SettingsPage: SettingsPage };
		}
		//#endregion

		const name = "dsh-balance-inquiry";
		const inject = ["slots", "locale"];

		function apply(ctx) {
			installStyles();
			const store = createStore();

			ctx.effect(() => ctx.locale.register(NS, { zh: zh, en: en }), "dsh-balance-inquiry: dictionaries");
			const t = ctx.locale.bind(NS);
			const components = createComponents(store, t);

			ctx.effect(() => store.start(), "dsh-balance-inquiry: quota polling");

			ctx.slots.inject("sidebar.footer.action", () =>
				ctx.slots.register(
					{
						name: "sidebar.footer.action",
						id: "quota",
						order: ENTRY_ORDER,
						locale: NS
					},
					(props) => h(components.QuotaEntry, props)
				)
			);

			ctx.slots.inject("settings.section", () =>
				ctx.slots.register(
					{
						name: "settings.section",
						id: "quota",
						order: SECTION_ORDER,
						label: () => t("settings.nav"),
						locale: NS
					},
					() => h(components.SettingsPage, null)
				)
			);
		}

		/** 仅供自测使用（tools/quota-smoke-test.cjs）：纯函数、签名与解析器。 */
		const internals = {
			defaultConfig: DEFAULT_CONFIG,
			sha256Hex: cpSha256Hex,
			hmacSha256Hex: function (key, message) {
				return cpHex(cpHmacSha256(cpUtf8(key), cpUtf8(message)));
			},
			volSign: cpVolSign,
			volCanonicalQuery: cpVolCanonicalQuery,
			volRegion: cpVolRegion,
			volResponseError: cpVolResponseError,
			volIsAuthError: cpVolIsAuthError,
			detectCodingPlanProvider: detectCodingPlanProvider,
			resolveProvider: resolveProvider,
			extractResetTime: cpExtractResetTime,
			zhipuQuotaFromBody: cpZhipuQuotaFromBody,
			parseZhipuTiers: cpParseZhipuTokenTiers,
			parseAfpTiers: cpParseAfpTiers,
			parseCodingPlanTiers: cpParseCodingPlanTiers
		};

		module.exports = { name: name, inject: inject, apply: apply, __internals: internals };
		return module.exports;
	}
});
