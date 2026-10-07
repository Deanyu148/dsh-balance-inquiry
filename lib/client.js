/**
 * dsh-balance-inquiry —— 浏览器半边（DSH 客户端 bundle）。
 *
 * 它做四件事：
 *   1. 往 `sidebar.footer.action` 注册一个条目（order 5），显示所有套餐里最紧急的余额；
 *   2. 左键点这个条目打开余额看板（`shell.overlay`），看板里每个套餐一张卡片；
 *   3. 往 `settings.section` 注册一个两级设置页：一级是套餐列表 + 添加套餐弹窗，
 *      二级是单个套餐的编辑页；
 *   4. 套餐、全局设置与最近读数都保存在 localStorage。
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
		const STORAGE_ACCOUNTS_LEGACY = "dsh-balance-inquiry:config";
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
		const DEFAULT_ACCOUNT_QUOTA_PER_UNIT = 500000; // New API：1 ￥ = 500000 quota
		const STORAGE_SETTINGS = "dsh-balance-inquiry:settings";
		const STORAGE_ACCOUNTS = "dsh-balance-inquiry:accounts";
		const STORAGE_RESULTS = "dsh-balance-inquiry:results";

		/** 全局设置（与具体套餐无关）。 */
		const DEFAULT_SETTINGS = {
			autoQueryInterval: 5, // 分钟，0 = 不自动查询
			timeoutSeconds: DEFAULT_TIMEOUT_SECONDS
		};

		/**
		 * 一个套餐：{ id, name, kind, pricing, provider, baseUrl, accessToken, ... }
		 * kind = "api"（按量计费，quota 需要换算）| "plan"（Token Plan / Coding Plan，
		 * 按百分比 / 积分 / credits 计，不做 quota 换算）。
		 */
		function normalizeAccount(raw) {
			const account = {
				id: "",
				name: "",
				kind: "api",
				pricing: "quota", // quota | credits | percent
				provider: "newapi",
				baseUrl: "",
				accessToken: "",
				userId: "",
				organizationId: "",
				projectId: "",
				accessKeyId: "",
				secretAccessKey: "",
				websiteUrl: "",
				quotaPerUnit: 500000,
				unit: "CNY",
				customScript: "",
				dshProviderId: ""
			};
			if (raw && typeof raw === "object") {
				for (const key of Object.keys(account)) {
					const value = raw[key];
					if (value !== undefined && value !== null) account[key] = value;
				}
			}
			account.id = String(account.id || "");
			account.name = String(account.name || "").trim();
			account.dshProviderId = String(account.dshProviderId || "").trim();
			const option = providerOption(account.provider);
			if (!option) account.provider = "newapi";
			// kind 跟随厂商：编程套餐一定是 plan，其余是 api（避免旧数据里 kind 与 provider 对不上）。
			account.kind = providerOption(account.provider).kind;
			account.baseUrl = String(account.baseUrl || "").trim().replace(/\/+$/, "");
			account.websiteUrl = String(account.websiteUrl || "").trim();
			account.accessToken = String(account.accessToken || "").trim();
			account.userId = String(account.userId || "").trim();
			account.organizationId = String(account.organizationId || "").trim();
			account.projectId = String(account.projectId || "").trim();
			account.accessKeyId = String(account.accessKeyId || "").trim();
			account.secretAccessKey = String(account.secretAccessKey || "").trim();
			account.customScript = String(account.customScript === undefined || account.customScript === null ? "" : account.customScript);
			account.unit = String(account.unit || "CNY").trim() || "CNY";
			account.quotaPerUnit = clampNumber(account.quotaPerUnit, DEFAULT_ACCOUNT_QUOTA_PER_UNIT, 1, 1e12);
			if (!account.name) account.name = providerOption(account.provider).label;
			return account;
		}

		const PROVIDER_OPTIONS = [
			{ id: "newapi", label: "New API / One API", kind: "api", quota: true },
			{ id: "deepseek", label: "DeepSeek 官方", kind: "api", quota: false },
			{ id: "stepfun", label: "阶跃星辰 StepFun", kind: "api", quota: false },
			{ id: "siliconflow", label: "SiliconFlow 硅基流动（国内）", kind: "api", quota: false },
			{ id: "siliconflow-en", label: "SiliconFlow（国际）", kind: "api", quota: false },
			{ id: "openrouter", label: "OpenRouter", kind: "api", quota: false },
			{ id: "novita", label: "Novita AI", kind: "api", quota: false },
			{ id: "cp-kimi", label: "Kimi For Coding", kind: "plan" },
			{ id: "cp-zhipu", label: "智谱 GLM", kind: "plan" },
			{ id: "cp-zhipu-team", label: "智谱 GLM 团队版", kind: "plan" },
			{ id: "cp-minimax", label: "MiniMax", kind: "plan" },
			{ id: "cp-zenmux", label: "ZenMux", kind: "plan" },
			{ id: "cp-volcengine", label: "火山方舟（Agent / Coding Plan）", kind: "plan" },
			{ id: "cp-opencode-go", label: "OpenCode Go", kind: "plan" },
			{ id: "cp-command-code", label: "Command Code", kind: "plan" },
			{ id: "custom", label: "自定义用量脚本", kind: "api", quota: true }
		];

		function providerOption(id) {
			return PROVIDER_OPTIONS.find((item) => item.id === id) || null;
		}

		/** 该厂商是否用 quota 计价（只有 New API / 自定义脚本需要换算比例）。 */
		function usesQuota(provider) {
			const option = providerOption(provider);
			return Boolean(option && option.quota);
		}

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
			"settings.updated.at": "查询时间：{time}（{ago}）",
			"settings.usedLine": "已用 {value}",
			"settings.totalLine": "总额 {value}",
			"entry.empty": "剩余额度：未添加套餐",
			"entry.tip.empty": "点这一行打开余额看板，在里面添加套餐",
			"entry.tip.balance": "{plan}：余额 {value}",
			"entry.tip.accountFailed": "{plan}：查询失败 —— {message}",
			"entry.tip.accountPending": "{plan}：尚未查询",
			"account.pending": "尚未查询",
			"account.failed": "查询失败",
			"account.line": "剩余额度：{value}",
			"account.remainingLine": "剩余额度：{value}",
			"account.percent": "剩余 {value}%",
			"account.resets": "重置时间：{time}",
			"account.updated": "上次查询：{time}（{ago}）",
			"account.stale": "上次查询：{time}（{ago}，重试中）",
			"account.error": "查询失败：{message}",
			"settings.add": "添加套餐",
			"settings.empty": "还没有套餐。点击上面的「添加套餐」开始。",
			"settings.global": "通用设置",
			"board.title": "余额看板",
			"board.add": "添加套餐",
			"board.refresh": "立即查询",
			"board.close": "关闭",
			"board.empty": "还没有套餐。点上面的「添加套餐」开始。",
			"board.card.tip": "左键打开这个套餐的官网地址",
			"board.card.updated": "上次查询：{time}",
			"board.card.never": "尚未查询",
			"picker.title": "添加套餐",
			"picker.provider": "选择厂商",
			"picker.api": "按量计费（API Key）",
			"picker.api.desc": "New API / DeepSeek / StepFun / SiliconFlow / OpenRouter / Novita / 自定义脚本",
			"picker.plan": "Token Plan / Coding Plan",
			"picker.plan.desc": "Kimi For Coding / 智谱 GLM / MiniMax / ZenMux / 火山方舟 / OpenCode Go / Command Code",
			"picker.back": "上一步",
			"picker.cancel": "取消",
			"picker.current": "使用当前正在用的供应商",
			"picker.current.desc": "{provider} ｜ {baseUrl}（检测到 DSH 当前正在使用它）",
			"form.name": "套餐名称",
			"form.name.placeholder": "例如 棉花云 / Kimi 套餐",
			"form.kind": "计费类型",
			"form.kind.api": "按量计费（API Key）",
			"form.kind.plan": "Token Plan / Coding Plan",
			"form.provider": "厂商",
			"form.baseUrl": "接口地址",
			"form.baseUrl.hint": "例如 https://api.example.com（末尾不要带 /）",
			"form.endpoint": "用量接口地址",
			"form.endpoint.volc": "接口地址（用于推断区域）",
			"form.endpoint.placeholder": "https://api.example.com",
			"form.endpoint.hint": "部分厂商需要；留空则用官方地址",
			"form.token": "访问令牌 / API Key",
			"form.token.hint": "New API 用控制台「系统访问令牌」，官方厂商填对应平台的 API Key",
			"form.planToken": "控制台令牌",
			"form.planToken.hint": "编程套餐填对应厂商控制台里的令牌",
			"form.showToken": "显示令牌",
			"form.userId": "用户 ID",
			"form.userId.hint": "作为 New-Api-User 请求头发送，部分站点必填",
			"form.teamOrg": "组织 ID",
			"form.teamOrg.hint": "智谱团队套餐必填，作为 bigmodel-organization 请求头发送",
			"form.teamProject": "项目 ID",
			"form.teamProject.hint": "智谱团队套餐必填，作为 bigmodel-project 请求头发送",
			"form.accessKeyId": "AccessKey ID",
			"form.accessKeyId.hint": "火山方舟用量查询必填：账号的 AccessKey ID（不是推理用的 API Key）",
			"form.secretAccessKey": "SecretAccessKey",
			"form.secretAccessKey.hint": "火山方舟用量查询必填：只用于本地签名，不会发给其它站点",
			"form.planHint": "编程套餐按各家的订阅接口查询，显示每个时间窗口的已用百分比；按积分 / credits 计的套餐不做 quota 换算。",
			"form.unit": "额度换算比例",
			"form.unit.hint": "New API：1 ￥ 等于多少 quota，默认 500000",
			"form.currency": "货币单位",
			"form.currency.hint": "New API 一般填 CNY；显示时会换算成 ￥",
			"form.script": "自定义用量脚本",
			"form.script.hint": "格式：({ request: { url, method, headers }, extractor: function (response) { … } })。占位符：{{apiKey}}、{{baseUrl}}、{{accessToken}}、{{userId}}、{{rate}}",
			"form.script.fillNewApi": "填入 New API 模板",
			"form.script.fillGeneric": "填入通用模板",
			"form.website": "官网地址",
			"form.website.hint": "点击看板里的套餐卡片时打开的网址；留空则使用接口地址",
			"form.dshProvider": "供应商ID",
			"form.dshProvider.none": "不设置",
			"form.dshProvider.hint": "绑定到 DSH 的 provider id：官方登录是 deepseek-official，账号登录是 deepseek-account，自定义供应商用 cordis.patch.yml 里 llm-pi-ai 的路由 id。在 DSH 中切换到该供应商时，左下角自动显示此套餐；不设置则始终按最紧急额度展示",
			"form.save": "保存",
			"form.back": "返回",
			"edit.back": "返回列表",
			"edit.queryNow": "立即查询",
			"edit.remove": "删除套餐",
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
			"settings.updated.at": "Queried: {time} ({ago})",
			"settings.usedLine": "used {value}",
			"settings.totalLine": "total {value}",
			"entry.empty": "Quota left: no plan yet",
			"entry.tip.empty": "Click to open the balance board and add a plan",
			"entry.tip.balance": "{plan}: balance {value}",
			"entry.tip.accountFailed": "{plan}: query failed - {message}",
			"entry.tip.accountPending": "{plan}: not queried yet",
			"account.pending": "not queried yet",
			"account.failed": "query failed",
			"account.line": "Quota left: {value}",
			"account.remainingLine": "Quota left: {value}",
			"account.percent": "{value}% left",
			"account.resets": "resets {time}",
			"account.updated": "last query {time} ({ago})",
			"account.stale": "last query {time} ({ago}, retrying)",
			"account.error": "query failed: {message}",
			"settings.add": "Add plan",
			"settings.empty": "No plan yet. Use Add plan above to get started.",
			"settings.global": "General",
			"board.title": "Balance board",
			"board.add": "Add plan",
			"board.refresh": "Refresh",
			"board.close": "Close",
			"board.empty": "No plan yet. Use Add plan above to get started.",
			"board.card.tip": "Left click opens this plan's provider site",
			"board.card.updated": "last query {time}",
			"board.card.never": "not queried yet",
			"picker.title": "Add plan",
			"picker.provider": "Pick a provider",
			"picker.api": "Pay-as-you-go (API key)",
			"picker.api.desc": "New API / DeepSeek / StepFun / SiliconFlow / OpenRouter / Novita / custom script",
			"picker.plan": "Token Plan / Coding Plan",
			"picker.plan.desc": "Kimi For Coding / Zhipu GLM / MiniMax / ZenMux / Volcengine / OpenCode Go / Command Code",
			"picker.back": "Back",
			"picker.cancel": "Cancel",
			"picker.current": "Use the provider in use now",
			"picker.current.desc": "{provider} | {baseUrl} (DSH is using this right now)",
			"form.name": "Plan name",
			"form.name.placeholder": "e.g. My gateway / Kimi plan",
			"form.kind": "Billing",
			"form.kind.api": "Pay-as-you-go (API key)",
			"form.kind.plan": "Token Plan / Coding Plan",
			"form.provider": "Provider",
			"form.baseUrl": "Endpoint",
			"form.baseUrl.hint": "e.g. https://api.example.com (no trailing slash)",
			"form.endpoint": "Usage endpoint",
			"form.endpoint.volc": "Endpoint (used to infer the region)",
			"form.endpoint.placeholder": "https://api.example.com",
			"form.endpoint.hint": "Required by some providers; empty uses the official host",
			"form.token": "Access token / API key",
			"form.token.hint": "New API takes a console system access token; native vendors take their platform API key",
			"form.planToken": "Console token",
			"form.planToken.hint": "Use the token shown in the vendor's console",
			"form.showToken": "Show token",
			"form.userId": "User ID",
			"form.userId.hint": "Sent as the New-Api-User header; required by some sites",
			"form.teamOrg": "Organization ID",
			"form.teamOrg.hint": "Required by Zhipu team plans; sent as bigmodel-organization",
			"form.teamProject": "Project ID",
			"form.teamProject.hint": "Required by Zhipu team plans; sent as bigmodel-project",
			"form.accessKeyId": "AccessKey ID",
			"form.accessKeyId.hint": "Volcengine usage queries need the account AccessKey ID (not the inference key)",
			"form.secretAccessKey": "SecretAccessKey",
			"form.secretAccessKey.hint": "Volcengine usage queries: used for local signing only",
			"form.planHint": "Token plans are read from each vendor's subscription API and shown as per-window percentages; credit-based plans are not converted through a quota rate.",
			"form.unit": "Quota rate",
			"form.unit.hint": "New API: how many quota units make 1 CNY, default 500000",
			"form.currency": "Currency",
			"form.currency.hint": "New API usually uses CNY",
			"form.script": "Custom usage script",
			"form.script.hint": "Shape: ({ request: { url, method, headers }, extractor: function (response) { ... } }). Placeholders: {{apiKey}}, {{baseUrl}}, {{accessToken}}, {{userId}}, {{rate}}",
			"form.script.fillNewApi": "Fill New API template",
			"form.script.fillGeneric": "Fill generic template",
			"form.website": "Provider website",
			"form.website.hint": "Opened by a left click on the board card; empty falls back to the endpoint",
			"form.dshProvider": "Provider ID",
			"form.dshProvider.none": "Not set",
			"form.dshProvider.hint": "Bind to a DSH provider id: deepseek-official for the official API-key login, deepseek-account for the account login, or a custom llm-pi-ai route id from cordis.patch.yml. When switching to that provider in DSH, the bottom-left entry automatically displays this plan; when not set, the most critical plan is always shown",
			"form.save": "Save",
			"form.back": "Back",
			"edit.back": "Back to list",
			"edit.queryNow": "Refresh now",
			"edit.remove": "Remove plan",
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
		let memorySettings = null;
		let memoryAccounts = null;
		let memoryResults = null;

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

		/** 归一化全局设置。 */
		function normalizeSettings(raw) {
			const settings = Object.assign({}, DEFAULT_SETTINGS);
			if (raw && typeof raw === "object") {
				for (const key of Object.keys(DEFAULT_SETTINGS)) {
					const value = raw[key];
					if (value !== undefined && value !== null) settings[key] = value;
				}
			}
			settings.autoQueryInterval = Math.round(clampNumber(settings.autoQueryInterval, DEFAULT_SETTINGS.autoQueryInterval, 0, MAX_INTERVAL_MINUTES));
			settings.timeoutSeconds = clampNumber(settings.timeoutSeconds, DEFAULT_SETTINGS.timeoutSeconds, MIN_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS);
			return settings;
		}

		function loadSettings() {
			if (memorySettings) return memorySettings;
			const raw = readStored(STORAGE_SETTINGS);
			if (raw === null) {
				memorySettings = normalizeSettings(null);
				return memorySettings;
			}
			try {
				memorySettings = normalizeSettings(JSON.parse(raw));
			} catch (error) {
				memorySettings = normalizeSettings(null);
			}
			return memorySettings;
		}

		function persistSettings(settings) {
			memorySettings = settings;
			writeStored(STORAGE_SETTINGS, JSON.stringify(settings));
		}

		/** 套餐列表；旧的「单套餐配置」在第一次读取时转成一条套餐。 */
		function loadAccounts() {
			if (memoryAccounts) return memoryAccounts;
			const raw = readStored(STORAGE_ACCOUNTS);
			if (raw !== null) {
				try {
					const parsed = JSON.parse(raw);
					memoryAccounts = Array.isArray(parsed) ? parsed.map(normalizeAccount) : [];
					return memoryAccounts;
				} catch (error) {
					memoryAccounts = [];
					return memoryAccounts;
				}
			}
			const legacy = readStored(STORAGE_ACCOUNTS_LEGACY);
			if (legacy === null) {
				memoryAccounts = [];
				return memoryAccounts;
			}
			try {
				memoryAccounts = [normalizeAccount(Object.assign({ id: "default", name: "" }, JSON.parse(legacy)))];
			} catch (error) {
				memoryAccounts = [];
			}
			persistAccounts(memoryAccounts);
			return memoryAccounts;
		}

		function persistAccounts(accounts) {
			memoryAccounts = accounts;
			writeStored(STORAGE_ACCOUNTS, JSON.stringify(accounts));
		}

		/** 每个套餐最近一次成功的读数（含时间），重启后仍能立刻显示。 */
		function loadResults() {
			if (memoryResults) return memoryResults;
			const raw = readStored(STORAGE_RESULTS);
			if (raw === null) {
				memoryResults = {};
				return memoryResults;
			}
			try {
				const parsed = JSON.parse(raw);
				memoryResults = parsed && typeof parsed === "object" ? parsed : {};
			} catch (error) {
				memoryResults = {};
			}
			return memoryResults;
		}

		function persistResults(results) {
			memoryResults = results;
			writeStored(STORAGE_RESULTS, JSON.stringify(results));
		}

		/** 生成套餐 id。 */
		function newAccountId() {
			return "a" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
		}
		//#endregion

		//#region 宿主代理（同源路由，见 lib/index.js）
		/**
		 * 浏览器直连受 CORS 限制：目标站没回 `Access-Control-Allow-Origin` 时 fetch 直接被拦。
		 * 所以先走宿主进程（宿主半边的 dsh-host-webserver 路由，无 CORS），
		 * 宿主路由不可用时再退回浏览器直连。
		 */
		const PROXY_PATH = "/plugins/dsh-balance-inquiry/proxy";
		const WHOAMI_PATH = "/plugins/dsh-balance-inquiry/whoami";
		const PROVIDERS_PATH = "/plugins/dsh-balance-inquiry/providers";
		const PROXY_STATE = { mode: "unknown" }; // unknown | host | browser

		/**
		 * 读宿主认到的「当前模型供应商」（仅 provider 与 model，不含敏感网络地址）。
		 */
		async function fetchCurrentProvider() {
			try {
				if (typeof location === "undefined" || !location || !location.href) return null;
				const url = new URL(WHOAMI_PATH, location.href).toString();
				const response = await fetch(url, { method: "GET", cache: "no-store", credentials: "same-origin" });
				if (!response || !response.ok) return null;
				const payload = JSON.parse(await response.text());
				return payload && payload.ok === true && payload.current ? payload.current : null;
			} catch (error) {
				return null;
			}
		}

		/**
		 * 读宿主中已配置的 provider 列表（仅 id 与 displayName）。
		 */
		async function fetchConfiguredProviders() {
			try {
				if (typeof location === "undefined" || !location || !location.href) return [];
				const url = new URL(PROVIDERS_PATH, location.href).toString();
				const response = await fetch(url, { method: "GET", cache: "no-store", credentials: "same-origin" });
				if (!response || !response.ok) return [];
				const payload = JSON.parse(await response.text());
				return payload && payload.ok === true && Array.isArray(payload.providers) ? payload.providers : [];
			} catch (error) {
				return [];
			}
		}

		/** 把宿主的供应商配置映射成本插件的厂商与接口地址。 */
		function mapCurrentProvider(current) {
			if (!current || !current.provider) return null;
			return { provider: current.provider, name: current.displayName || current.provider || "", dshProviderId: current.provider };
		}

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
		/** 按 URL 小写包含判断原生厂商（仅用于「添加套餐」时给个默认值，不参与查询决策）。 */
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

		/** 套餐上写的就是最终生效的厂商，不再做地址嗅探。 */
		function resolveProvider(account) {
			return providerOption(account.provider) ? account.provider : "newapi";
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
		async function queryNewApi(account) {
			const config = account;
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
			const rate = clampNumber(config.quotaPerUnit, DEFAULT_ACCOUNT_QUOTA_PER_UNIT, 1, 1e12);
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
		/** 一个套餐缺什么就说清楚，避免用户对着「未配置」猜。 */
		function missingRequirements(account) {
			const provider = resolveProvider(account);
			if (provider === "custom") {
				if (!String(account.customScript || "").trim()) return "尚未填写自定义脚本";
				if (!account.accessToken) return "API key is empty";
				return "";
			}
			if (provider === "newapi") {
				if (!account.baseUrl) return "未填写接口地址";
				if (!account.accessToken) return "API key is empty";
				return "";
			}
			if (provider === "cp-zhipu-team") {
				if (!account.accessToken) return "API key is empty";
				if (!account.organizationId || !account.projectId) return "Zhipu team plan needs the API key + organization ID + project ID";
				return "";
			}
			if (provider === "cp-volcengine") {
				if (!account.accessKeyId || !account.secretAccessKey) return "Volcengine usage query needs the account AccessKey ID + SecretAccessKey (not the inference API key)";
				return "";
			}
			if (!account.accessToken) return "API key is empty";
			return "";
		}

		function accountReady(account) {
			return missingRequirements(account) === "";
		}

		async function queryOnce(account) {
			const provider = resolveProvider(account);
			if (provider === "custom") return queryScript(account);
			if (isCodingPlanProvider(provider)) return queryCodingPlan(provider, account);
			if (provider === "newapi") return queryNewApi(account);
			if (NATIVE_PROVIDERS[provider]) return queryNative(provider, account, { Authorization: "Bearer " + account.accessToken });
			return failResult("Unknown balance provider");
		}

		async function queryAccount(account) {
			const missing = missingRequirements(account);
			if (missing) return failResult(missing);
			try {
				return await queryOnce(account);
			} catch (error) {
				if (!error || !error.transient) throw error;
				// 只对传输层失败重试一次。
				await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
				return await queryOnce(account);
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
			let settings = loadSettings();
			let accounts = loadAccounts();
			let results = loadResults(); // { [accountId]: { data, at, stale, error } }
			let state = {
				settings: settings,
				accounts: accounts,
				results: results,
				currentDshProviderId: "",
				phase: accounts.length ? "idle" : "empty",
				refreshing: false,
				updatedAt: 0
			};
			let timer = 0;
			let whoamiTimer = 0;
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
				const minutes = clampNumber(state.settings.autoQueryInterval, 0, 0, MAX_INTERVAL_MINUTES);
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
				if (!state.updatedAt || Date.now() - state.updatedAt >= wait) refresh();
			};

			/** 把一次查询结果并进该套餐的读数：成功刷新读数，确定性失败清掉旧值，瞬时失败保留上次成功值。 */
			function applyResult(accountId, result, at) {
				const next = Object.assign({}, state.results);
				const previous = next[accountId] || null;
				if (result && result.success) {
					next[accountId] = { data: result, at: at, stale: false, error: hasInvalidItem(result) ? firstInvalidMessage(result) : "" };
				} else if (result && !isTransientResult(result)) {
					next[accountId] = { data: null, at: at, stale: false, error: String(result.error || "") };
				} else {
					const keep = previous && previous.data && at - previous.at < KEEP_LAST_GOOD_MS ? previous : null;
					next[accountId] = keep
						? { data: keep.data, at: keep.at, stale: true, error: String((result && result.error) || "") }
						: { data: null, at: at, stale: false, error: String((result && result.error) || "") };
				}
				persistResults(next);
				patch({ results: next });
			}

			async function refresh() {
				if (timer) clearTimeout(timer);
				if (inFlight) {
					arm();
					return state;
				}
				const list = state.accounts;
				if (!list.length) {
					patch({ phase: "empty", refreshing: false });
					arm();
					return state;
				}
				inFlight = true;
				patch({ refreshing: true });
				await Promise.all(
					list.map(async (account) => {
						const at = Date.now();
						try {
							const result = await queryAccount(account);
							applyResult(account.id, result, Date.now());
						} catch (error) {
							const message = describeError(error, account.baseUrl);
							applyResult(account.id, failResult(message), at);
						}
					})
				);
				inFlight = false;
				patch({ refreshing: false, phase: "ready", updatedAt: Date.now() });
				arm();
				return state;
			}

			function commitAccounts(next) {
				persistAccounts(next);
				const kept = {};
				for (const account of next) {
					if (state.results[account.id]) kept[account.id] = state.results[account.id];
				}
				persistResults(kept);
				patch({ accounts: next, results: kept, phase: next.length ? state.phase : "empty" });
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
				getSettings() {
					return state.settings;
				},
				getAccounts() {
					return state.accounts;
				},
				getAccount(id) {
					return state.accounts.find((account) => account.id === id) || null;
				},
				saveSettings(changes) {
					const next = normalizeSettings(Object.assign({}, state.settings, changes));
					persistSettings(next);
					patch({ settings: next });
				},
				addAccount(raw) {
					const account = normalizeAccount(Object.assign({ id: newAccountId() }, raw));
					commitAccounts(state.accounts.concat([account]));
					return account;
				},
				updateAccount(id, changes) {
					const next = state.accounts.map((account) => (account.id === id ? normalizeAccount(Object.assign({}, account, changes, { id: id })) : account));
					commitAccounts(next);
				},
				removeAccount(id) {
					commitAccounts(state.accounts.filter((account) => account.id !== id));
				},
				refreshAccount(id) {
					const account = state.accounts.find((item) => item.id === id);
					if (!account) return Promise.resolve(state);
					const at = Date.now();
					return queryAccount(account)
						.then((result) => {
							applyResult(id, result, Date.now());
							return state;
						})
						.catch((error) => {
							applyResult(id, failResult(describeError(error, account.baseUrl)), at);
							return state;
						});
				},
				refresh,
				checkCurrentProvider() {
					return fetchCurrentProvider()
						.then((current) => {
							const id = current && current.provider ? String(current.provider) : "";
							if (id !== state.currentDshProviderId) {
								patch({ currentDshProviderId: id });
							}
							return id;
						})
						.catch(() => "");
				},
				start() {
					if (state.accounts.length) refresh();
					else patch({ phase: "empty", refreshing: false });
					// 仅当配置了带 dshProviderId 的套餐时才定期轮询 whoami，或在页面聚焦时按需检查
					const needsWhoami = () => state.accounts.some((a) => Boolean(a.dshProviderId));
					if (needsWhoami()) this.checkCurrentProvider();
					whoamiTimer = setInterval(() => {
						if (needsWhoami()) this.checkCurrentProvider();
					}, 10000);
					if (typeof document !== "undefined" && document.addEventListener) {
						document.addEventListener("visibilitychange", onVisibility);
					}
					if (typeof window !== "undefined" && window.addEventListener) {
						window.addEventListener("focus", () => {
							if (needsWhoami()) this.checkCurrentProvider();
						});
					}
					return () => {
						if (timer) clearTimeout(timer);
						timer = 0;
						if (whoamiTimer) clearInterval(whoamiTimer);
						whoamiTimer = 0;
						if (typeof document !== "undefined" && document.removeEventListener) {
							document.removeEventListener("visibilitychange", onVisibility);
						}
					};
				}
			};
		}
		//#endregion

		//#region 样式
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
.dsh-balance-inquiry-accounts{display:flex;flex-direction:column;gap:8px}
.dsh-balance-inquiry-account{box-sizing:border-box;width:100%;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.04));color:inherit;font-family:inherit;font-size:13px;line-height:20px;cursor:pointer;text-align:left}
.dsh-balance-inquiry-account:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.dsh-balance-inquiry-account-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-balance-inquiry-account-value{flex:none;color:var(--dsw-alias-label-secondary,#8b8b8b)}
.dsh-balance-inquiry-account.dsh-balance-inquiry-danger .dsh-balance-inquiry-account-value{color:var(--dsw-alias-state-error-primary,#e5534b)}
.dsh-balance-inquiry-account.dsh-balance-inquiry-warning .dsh-balance-inquiry-account-value{color:var(--dsw-alias-state-warn-primary,#d29922)}
.dsh-balance-inquiry-modal{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45)}
.dsh-balance-inquiry-modal-card{box-sizing:border-box;width:min(420px,calc(100vw - 48px));max-height:calc(100vh - 96px);overflow:auto;display:flex;flex-direction:column;gap:12px;padding:18px;border-radius:14px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));background:var(--dsw-alias-bg-base,#17181c);color:var(--dsw-alias-label-primary,#e6e6e6);box-shadow:0 18px 48px rgba(0,0,0,.45)}
.dsh-balance-inquiry-choices{display:flex;flex-direction:column;gap:8px;max-height:50vh;overflow:auto}
.dsh-balance-inquiry-choice{box-sizing:border-box;width:100%;display:flex;flex-direction:column;gap:2px;padding:10px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));background:0 0;color:inherit;font-family:inherit;font-size:13px;line-height:18px;cursor:pointer;text-align:left}
.dsh-balance-inquiry-choice:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.dsh-balance-inquiry-choice-title{font-weight:600}
.dsh-balance-inquiry-choice-desc{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#8b8b8b)}
.dsh-balance-inquiry-board-mask{position:fixed;inset:0;z-index:55;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45)}
.dsh-balance-inquiry-board{box-sizing:border-box;width:min(720px,calc(100vw - 48px));max-height:calc(100vh - 96px);overflow:auto;display:flex;flex-direction:column;gap:14px;padding:20px;border-radius:16px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.08));background:var(--dsw-alias-bg-base,#17181c);color:var(--dsw-alias-label-primary,#e6e6e6);box-shadow:0 18px 48px rgba(0,0,0,.45)}
.dsh-balance-inquiry-board-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.dsh-balance-inquiry-board-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}
.dsh-balance-inquiry-card{box-sizing:border-box;width:100%;min-height:104px;display:flex;flex-direction:column;gap:6px;align-items:flex-start;padding:14px 16px;border-radius:14px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.04));color:inherit;font-family:inherit;cursor:pointer;text-align:left}
.dsh-balance-inquiry-card:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.dsh-balance-inquiry-card-name{font-size:13px;line-height:18px;color:var(--dsw-alias-label-secondary,#8b8b8b);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-balance-inquiry-card-value{font-size:20px;line-height:26px;font-weight:600}
.dsh-balance-inquiry-card-meta{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#8b8b8b)}
.dsh-balance-inquiry-card.dsh-balance-inquiry-danger .dsh-balance-inquiry-card-value{color:var(--dsw-alias-state-error-primary,#e5534b)}
.dsh-balance-inquiry-card.dsh-balance-inquiry-warning .dsh-balance-inquiry-card-value{color:var(--dsw-alias-state-warn-primary,#d29922)}
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
		/** 极简可观察对象：看板开关与设置页的两级导航用它保存跨渲染的状态。 */
		function createObservable(initial) {
			let value = initial;
			const listeners = new Set();
			return {
				get() {
					return value;
				},
				set(next) {
					if (value === next) return;
					value = next;
					for (const listener of Array.from(listeners)) {
						try {
							listener();
						} catch (error) {
							// 忽略单个订阅者的异常
						}
					}
				},
				subscribe(listener) {
					listeners.add(listener);
					return () => listeners.delete(listener);
				}
			};
		}

		const boardFlag = createObservable(false);
		/** 设置页视图：{ mode: "list" | "account", accountId }。 */
		const settingsView = createObservable({ mode: "list", accountId: null });
		/** 「添加套餐」弹窗开关（设置页与看板共用）。 */
		const pickerFlag = createObservable(false);

		function createComponents(store, t) {
			const useQuotaState = React.useSyncExternalStore
				? () => React.useSyncExternalStore(store.subscribe, store.getState)
				: () => {
						const pair = React.useState(0);
						const force = pair[1];
						React.useEffect(() => store.subscribe(() => force((value) => value + 1)), [store.subscribe]);
						return store.getState();
					};

			/** 套餐读数。 */
			function readingOf(state, accountId) {
				return state.results[accountId] || null;
			}

			/** 套餐的展示记录：优先取第一条有数值的。 */
			function accountValue(account, reading) {
				if (!reading || !reading.data || !reading.data.data) return null;
				const item = primaryItem(reading.data.data);
				if (!item || typeof item.remaining !== "number") return null;
				return item;
			}

			function accountTone(account, reading) {
				const item = accountValue(account, reading);
				if (!item) return reading && reading.error ? "danger" : "normal";
				if (item.remaining <= 0) return "danger";
				if (isTierItem(item)) return toneForLeft(leftPercentOf(item));
				return "normal";
			}

			/** 一个套餐的一行状态文案（多档位时重置时间留给逐条记录展示，避免重复）。 */
			function readingText(account, reading) {
				if (!reading) return t("account.pending");
				if (accountValue(account, reading)) {
					const item = accountValue(account, reading);
					const tiers = reading.data && reading.data.data ? reading.data.data : [];
					const parts = [format(t("account.remainingLine"), { value: formatValue(item.remaining, item.unit) })];
					const percent = leftPercentOf(item);
					if (percent !== null) parts.push(format(t("account.percent"), { value: formatMoney(percent) }));
					if (tiers.length <= 1 && typeof item.extra === "string" && item.extra) parts.push(format(t("account.resets"), { time: item.extra }));
					parts.push(format(t(reading.stale ? "account.stale" : "account.updated"), { time: formatTime(reading.at), ago: formatRelativeTime(reading.at) }));
					return parts.join(" ｜ ");
				}
				if (reading.error) return format(t("account.error"), { message: reading.error });
				return t("account.pending");
			}

			/** 一个套餐的逐条记录（多档位时一条一行）。 */
			function planRows(reading) {
				if (!reading || !reading.data || !reading.data.data) return [];
				return reading.data.data.map((item, index) => {
					const tone = item && item.isValid === false ? "danger" : isTierItem(item) ? toneForLeft(leftPercentOf(item)) : toneForLeft(item && item.remaining <= 0 ? 0 : null);
					const detail = [];
					if (item && typeof item.remaining === "number") detail.push(formatValue(item.remaining, item.unit));
					if (item && typeof item.used === "number") detail.push(format(t("settings.usedLine"), { value: formatValue(item.used, item.unit) }));
					if (item && typeof item.total === "number" && item.total > 0) detail.push(format(t("settings.totalLine"), { value: formatValue(item.total, item.unit) }));
					const percent = leftPercentOf(item);
					if (percent !== null) detail.push(format(t("account.percent"), { value: formatMoney(percent) }));
					if (item && typeof item.extra === "string" && item.extra) detail.push(format(t("settings.resets"), { time: item.extra }));
					return h(
						"div",
						{ className: "dsh-balance-inquiry-plan dsh-balance-inquiry-" + tone, key: index },
						h("span", { className: "dsh-balance-inquiry-plan-name" }, (item && item.planName) || "—"),
						h("span", { className: "dsh-balance-inquiry-plan-value" }, detail.join(" ｜ "))
					);
				});
			}

			/** 查询通道：宿主进程代理还是浏览器直连。 */
			function transportText() {
				const mode = PROXY_STATE.mode;
				if (mode === "host") return t("settings.transport.host");
				if (mode === "browser") return t("settings.transport.browser");
				return t("settings.transport.unknown");
			}

			/** 侧边栏那一行：若当前 DSH 供应商绑定了某个套餐，优先显示该套餐；否则回退到最紧急的一条。 */
			function entrySummary(state) {
				if (state.currentDshProviderId) {
					const matched = state.accounts.find((account) => account.dshProviderId && account.dshProviderId === state.currentDshProviderId);
					if (matched) {
						const value = accountValue(matched, readingOf(state, matched.id));
						if (value) return value;
					}
				}
				let best = null;
				for (const account of state.accounts) {
					const item = accountValue(account, readingOf(state, account.id));
					if (!item) continue;
					if (!best || item.remaining < best.remaining) best = item;
				}
				return best;
			}

			function entryLabel(state) {
				try {
					const item = entrySummary(state);
					if (item) {
						return format(t("entry.value"), {
							amount: formatMoney(item.remaining),
							unit: unitSymbol(item.unit) || "￥"
						});
					}
					if (!state.accounts.length) return t("entry.empty");
					if (state.refreshing) return t("entry.loading");
					return t("entry.idle");
				} catch (error) {
					return t("entry.error");
				}
			}

			function entryTitle(state) {
				const now = Date.now();
				const lines = [t("entry.tip")];
				if (!state.accounts.length) {
					lines.push(t("entry.tip.empty"));
					return lines.filter(Boolean).join("\n");
				}
				for (const account of state.accounts) {
					const reading = readingOf(state, account.id);
					const item = accountValue(account, reading);
					if (item) {
						lines.push(format(t("entry.tip.balance"), { plan: account.name, value: formatValue(item.remaining, item.unit) }));
						if (item.remaining <= 0) lines.push(t("entry.tip.danger"));
						if (typeof item.extra === "string" && item.extra) lines.push(format(t("entry.tip.resets"), { time: item.extra }));
						// 多档位（编程套餐）时把每个窗口的名称也列出来。
						const tiers = reading && reading.data && reading.data.data ? reading.data.data : [];
						if (tiers.length > 1) {
							for (const tier of tiers) {
								if (tier && typeof tier.planName === "string" && tier.planName) lines.push("　　" + tier.planName);
							}
						} else if (item.planName && item.planName !== account.name) {
							lines.push("　　" + item.planName);
						}
					}
					if (reading && reading.error) {
						// 有旧值也要给出失败原因；没有旧值时就只有这一行。
						lines.push(format(t("entry.tip.accountFailed"), { plan: account.name, message: reading.error }));
					} else if (!item) {
						lines.push(format(t("entry.tip.accountPending"), { plan: account.name }));
					}
				}
				const stamps = state.accounts.map((account) => readingOf(state, account.id)).filter((reading) => reading && reading.at);
				if (stamps.length) {
					const newest = stamps.reduce((left, right) => (right.at > left.at ? right : left));
					lines.push(
						format(t(newest.stale ? "entry.tip.stale" : "entry.tip.updated"), {
							time: formatTime(newest.at),
							ago: formatRelativeTime(newest.at, now)
						})
					);
				}
				return lines.filter(Boolean).join("\n");
			}

			function entryTone(state) {
				let tone = "normal";
				for (const account of state.accounts) {
					const next = accountTone(account, readingOf(state, account.id));
					if (next === "danger") return "danger";
					if (next === "warning") tone = "warning";
				}
				return tone;
			}

			/** 侧边栏按钮：左键开关余额看板。 */
			function QuotaEntry(props) {
				const state = useQuotaState();
				const wide = props && props.wide === true;
				const label = entryLabel(state);
				const base = wide ? "dsh-balance-inquiry-entry" : "dsh-balance-inquiry-entry dsh-balance-inquiry-entry-rail";
				const tone = entryTone(state);
				const className =
					tone === "danger"
						? base + " dsh-balance-inquiry-entry-error"
						: tone === "warning"
							? base + " dsh-balance-inquiry-entry-warning"
							: base;
				return h(
					"button",
					{
						type: "button",
						className: className,
						title: entryTitle(state),
						"aria-label": label,
						onClick: () => boardFlag.set(!boardFlag.get())
					},
					h(QuotaIcon, { size: wide ? 16 : 18, className: "dsh-balance-inquiry-entry-icon" }),
					wide ? h("span", { className: "dsh-balance-inquiry-entry-label" }, label) : null
				);
			}

			/** 套餐表单：按 kind / 厂商只显示需要的字段。 */
			function AccountForm(props) {
				const account = props.account;
				const secretPair = React.useState(false);
				const showSecret = secretPair[0];
				const setShowSecret = secretPair[1];
				const draftPair = React.useState(account);
				const draft = draftPair[0];
				const setDraft = draftPair[1];
				React.useEffect(() => setDraft(account), [account]);
				const provider = resolveProvider(draft);
				const isNative = Boolean(NATIVE_PROVIDERS[provider]);
				const isCustom = provider === "custom";
				const isNewApiLike = provider === "newapi";
				const isCodingPlan = isCodingPlanProvider(provider);
				const isVolc = provider === "cp-volcengine";
				const needQuota = usesQuota(provider);
				const set = (key, value) => setDraft(Object.assign({}, draft, { [key]: value }));

				const dshProvidersPair = React.useState([]);
				const dshProviders = dshProvidersPair[0];
				const setDshProviders = dshProvidersPair[1];

				React.useEffect(() => {
					let alive = true;
					fetchConfiguredProviders().then((list) => {
						if (alive && Array.isArray(list)) setDshProviders(list);
					}).catch(() => {});
					return () => {
						alive = false;
					};
				}, []);

				const field = (key, label, options) => {
					const opts = options || {};
					return h(
						"label",
						{ className: "dsh-balance-inquiry-field", key: key },
						h("span", { className: "dsh-balance-inquiry-field-label" }, label),
						h("input", {
							className: "dsh-balance-inquiry-input",
							type: opts.secret && !showSecret ? "password" : opts.type || "text",
							value: draft[key] === undefined || draft[key] === null ? "" : String(draft[key]),
							placeholder: opts.placeholder || "",
							spellCheck: false,
							autoComplete: "off",
							onChange: (event) => set(key, event.target.value)
						}),
						opts.hint ? h("span", { className: "dsh-balance-inquiry-hint" }, opts.hint) : null
					);
				};

				const providerOptions = PROVIDER_OPTIONS.filter((item) => item.kind === draft.kind);

				return h(
					"div",
					{ className: "dsh-balance-inquiry-page" },
					field("name", t("form.name"), { placeholder: t("form.name.placeholder") }),
					h(
						"label",
						{ className: "dsh-balance-inquiry-field" },
						h("span", { className: "dsh-balance-inquiry-field-label" }, t("form.kind")),
						h(
							"select",
							{
								className: "dsh-balance-inquiry-input",
								value: draft.kind,
								onChange: (event) => {
									const nextKind = event.target.value;
									const first = PROVIDER_OPTIONS.find((item) => item.kind === nextKind);
									setDraft(Object.assign({}, draft, { kind: nextKind, provider: first ? first.id : draft.provider }));
								}
							},
							h("option", { value: "api" }, t("form.kind.api")),
							h("option", { value: "plan" }, t("form.kind.plan"))
						)
					),
					h(
						"label",
						{ className: "dsh-balance-inquiry-field" },
						h("span", { className: "dsh-balance-inquiry-field-label" }, t("form.provider")),
						h(
							"select",
							{
								className: "dsh-balance-inquiry-input",
								value: provider,
								onChange: (event) => {
									const nextProvider = event.target.value;
									const option = providerOption(nextProvider);
									setDraft(Object.assign({}, draft, { provider: nextProvider, kind: option ? option.kind : draft.kind }));
								}
							},
							providerOptions.map((item) => h("option", { key: item.id, value: item.id }, item.label))
						)
					),
					h(
						"label",
						{ className: "dsh-balance-inquiry-field" },
						h("span", { className: "dsh-balance-inquiry-field-label" }, t("form.dshProvider")),
						h(
							"select",
							{
								className: "dsh-balance-inquiry-input",
								value: draft.dshProviderId || "",
								onChange: (event) => set("dshProviderId", event.target.value)
							},
							h("option", { value: "" }, t("form.dshProvider.none")),
							dshProviders.map((item) => h("option", { key: item.id, value: item.id }, item.displayName ? `${item.displayName} (${item.id})` : item.id))
						),
						h("span", { className: "dsh-balance-inquiry-hint" }, t("form.dshProvider.hint"))
					),
					// 原生厂商用固定地址、不显示地址字段；编程套餐用「用量接口地址」这个更贴切的标题；
					// New API / 自定义脚本用普通「接口地址」。
					isNative ? null : isCodingPlan
						? field("baseUrl", t(isVolc ? "form.endpoint.volc" : "form.endpoint"), { placeholder: isVolc ? "https://ark.cn-beijing.volces.com/api/plan/v3" : t("form.endpoint.placeholder"), hint: t("form.endpoint.hint") })
						: field("baseUrl", t("form.baseUrl"), { placeholder: "https://api.example.com", hint: t("form.baseUrl.hint") }),
					field("accessToken", isCodingPlan ? t("form.planToken") : t("form.token"), { secret: true, hint: isCodingPlan ? t("form.planToken.hint") : t("form.token.hint") }),
					h(
						"div",
						{ className: "dsh-balance-inquiry-row" },
						h(
							"label",
							{ className: "dsh-balance-inquiry-check" },
							h("input", { type: "checkbox", checked: showSecret, onChange: (event) => setShowSecret(event.target.checked) }),
							t("form.showToken")
						)
					),
					isNewApiLike || isCustom ? field("userId", t("form.userId"), { hint: t("form.userId.hint") }) : null,
					provider === "cp-zhipu-team" ? field("organizationId", t("form.teamOrg"), { hint: t("form.teamOrg.hint") }) : null,
					provider === "cp-zhipu-team" ? field("projectId", t("form.teamProject"), { hint: t("form.teamProject.hint") }) : null,
					isVolc ? field("accessKeyId", t("form.accessKeyId"), { hint: t("form.accessKeyId.hint") }) : null,
					isVolc ? field("secretAccessKey", t("form.secretAccessKey"), { secret: true, hint: t("form.secretAccessKey.hint") }) : null,
					isCodingPlan ? h("p", { className: "dsh-balance-inquiry-desc" }, t("form.planHint")) : null,
					needQuota ? field("quotaPerUnit", t("form.unit"), { type: "number", hint: t("form.unit.hint") }) : null,
					needQuota ? field("unit", t("form.currency"), { hint: t("form.currency.hint") }) : null,
					isCustom
						? h(
								"label",
								{ className: "dsh-balance-inquiry-field" },
								h("span", { className: "dsh-balance-inquiry-field-label" }, t("form.script")),
								h("textarea", {
									className: "dsh-balance-inquiry-textarea",
									value: String(draft.customScript || ""),
									spellCheck: false,
									rows: 8,
									onChange: (event) => set("customScript", event.target.value)
								}),
								h("span", { className: "dsh-balance-inquiry-hint" }, t("form.script.hint")),
								h(
									"div",
									{ className: "dsh-balance-inquiry-row" },
									h(
										"button",
										{
											type: "button",
											className: "dsh-balance-inquiry-btn",
											onClick: () => set("customScript", NEW_API_TEMPLATE.split("{{rate}}").join(String(clampNumber(draft.quotaPerUnit, DEFAULT_ACCOUNT_QUOTA_PER_UNIT, 1, 1e12))))
										},
										t("form.script.fillNewApi")
									),
									h("button", { type: "button", className: "dsh-balance-inquiry-btn", onClick: () => set("customScript", GENERIC_TEMPLATE) }, t("form.script.fillGeneric"))
								)
							)
						: null,
					field("websiteUrl", t("form.website"), { placeholder: draft.baseUrl || "https://api.example.com", hint: t("form.website.hint") }),
					h(
						"div",
						{ className: "dsh-balance-inquiry-row" },
						h("button", { type: "button", className: "dsh-balance-inquiry-btn dsh-balance-inquiry-btn-primary", onClick: () => props.onSave(draft) }, t("form.save")),
						props.onCancel ? h("button", { type: "button", className: "dsh-balance-inquiry-btn", onClick: props.onCancel }, t("form.back")) : null
					)
				);
			}

			/** 添加套餐弹窗：第一步选计费类型，第二步选厂商；检测到当前正在用的供应商就置顶一个一键添加。 */
			function AccountPicker(props) {
				const stepPair = React.useState(0);
				const step = stepPair[0];
				const setStep = stepPair[1];
				const kindPair = React.useState("api");
				const kind = kindPair[0];
				const setKind = kindPair[1];
				const currentPair = React.useState(null);
				const current = currentPair[0];
				const setCurrent = currentPair[1];
				React.useEffect(() => {
					let alive = true;
					fetchCurrentProvider()
						.then((raw) => {
							if (!alive) return;
							const mapped = mapCurrentProvider(raw);
							if (mapped) setCurrent(mapped);
						})
						.catch(() => {});
					return () => {
						alive = false;
					};
				}, []);
				const addCurrent = () => {
					const opt = providerOption(current.provider) || PROVIDER_OPTIONS[0];
					const account = store.addAccount({
						provider: opt.id,
						kind: opt.kind,
						name: current.name || opt.label,
						dshProviderId: current.dshProviderId || ""
					});
					props.onCreated(account.id);
				};
				return h(
					"div",
					{ className: "dsh-balance-inquiry-modal" },
					h(
						"div",
						{ className: "dsh-balance-inquiry-modal-card" },
						h("h3", { className: "dsh-balance-inquiry-title" }, t(step === 0 ? "picker.title" : "picker.provider")),
						current && step === 1 && (providerOption(current.provider) ? providerOption(current.provider).kind === kind : kind === "api")
							? h(
									"button",
									{ type: "button", className: "dsh-balance-inquiry-choice dsh-balance-inquiry-choice-current", onClick: addCurrent },
									h("span", { className: "dsh-balance-inquiry-choice-title" }, t("picker.current")),
									h(
										"span",
										{ className: "dsh-balance-inquiry-choice-desc" },
										format(t("picker.current.desc"), {
											provider: (providerOption(current.provider) && providerOption(current.provider).label) || current.provider,
											baseUrl: current.dshProviderId ? `ID: ${current.dshProviderId}` : ""
										})
									)
								)
							: null,
						step === 0
							? h(
									"div",
									{ className: "dsh-balance-inquiry-choices" },
									h(
										"button",
										{
											type: "button",
											className: "dsh-balance-inquiry-choice",
											onClick: () => {
												setKind("api");
												setStep(1);
											}
										},
										h("span", { className: "dsh-balance-inquiry-choice-title" }, t("picker.api")),
										h("span", { className: "dsh-balance-inquiry-choice-desc" }, t("picker.api.desc"))
									),
									h(
										"button",
										{
											type: "button",
											className: "dsh-balance-inquiry-choice",
											onClick: () => {
												setKind("plan");
												setStep(1);
											}
										},
										h("span", { className: "dsh-balance-inquiry-choice-title" }, t("picker.plan")),
										h("span", { className: "dsh-balance-inquiry-choice-desc" }, t("picker.plan.desc"))
									)
								)
							: h(
									"div",
									{ className: "dsh-balance-inquiry-choices" },
									PROVIDER_OPTIONS.filter((item) => item.kind === kind).map((item) =>
										h(
											"button",
											{
												type: "button",
												key: item.id,
												className: "dsh-balance-inquiry-choice",
												onClick: () => {
													const account = store.addAccount({ provider: item.id, kind: item.kind, name: item.label });
													props.onCreated(account.id);
												}
											},
											item.label
										)
									)
								),
						h(
							"div",
							{ className: "dsh-balance-inquiry-row" },
							step === 1 ? h("button", { type: "button", className: "dsh-balance-inquiry-btn", onClick: () => setStep(0) }, t("picker.back")) : null,
							h("button", { type: "button", className: "dsh-balance-inquiry-btn", onClick: props.onClose }, t("picker.cancel"))
						)
					)
				);
			}

			/** 一级设置页：添加套餐 + 已添加套餐（长条按钮）+ 全局设置。 */
			function SettingsPage() {
				const state = useQuotaState();
				const view = React.useSyncExternalStore
					? React.useSyncExternalStore(settingsView.subscribe, settingsView.get)
					: settingsView.get();
				const pickerOpen = React.useSyncExternalStore
					? React.useSyncExternalStore(pickerFlag.subscribe, pickerFlag.get)
					: pickerFlag.get();
				const setView = (next) => settingsView.set(next);
				const setPickerOpen = (next) => pickerFlag.set(next);
				const settingsPair = React.useState(null);
				const settingsDraft = settingsPair[0];
				const setSettingsDraft = settingsPair[1];
				const noticePair = React.useState("");
				const notice = noticePair[0];
				const setNotice = noticePair[1];
				const settings = settingsDraft || state.settings;
				const setSetting = (key, value) => setSettingsDraft(Object.assign({}, settings, { [key]: value }));

				if (view.mode === "account" && view.accountId) {
					const account = store.getAccount(view.accountId);
					if (!account) {
						setView({ mode: "list", accountId: null });
						return null;
					}
					const reading = readingOf(state, account.id);
					const tone = accountTone(account, reading);
					return h(
						"div",
						{ className: "dsh-balance-inquiry-page" },
						h(
							"div",
							{ className: "dsh-balance-inquiry-row" },
							h("button", { type: "button", className: "dsh-balance-inquiry-btn", onClick: () => setView({ mode: "list", accountId: null }) }, t("edit.back")),
							h("button", { type: "button", className: "dsh-balance-inquiry-btn", onClick: () => store.refreshAccount(account.id) }, t("edit.queryNow")),
							h(
								"button",
								{
									type: "button",
									className: "dsh-balance-inquiry-btn",
									onClick: () => {
										store.removeAccount(account.id);
										setView({ mode: "list", accountId: null });
									}
								},
								t("edit.remove")
							)
						),
						h("h2", { className: "dsh-balance-inquiry-title" }, account.name || t("form.name.placeholder")),
						h("div", { className: tone === "danger" ? "dsh-balance-inquiry-status dsh-balance-inquiry-status-error" : "dsh-balance-inquiry-status" }, readingText(account, reading)),
						planRows(reading).length
							? h(
									"div",
									{ className: "dsh-balance-inquiry-plans" },
									h("div", { className: "dsh-balance-inquiry-status" }, format(t("settings.plans"), { count: planRows(reading).length })),
									planRows(reading)
								)
							: null,
						h(AccountForm, {
							account: account,
							onSave: (draft) => {
								store.updateAccount(account.id, draft);
								setNotice(t("settings.saved"));
								store.refreshAccount(account.id);
								setView({ mode: "list", accountId: null });
							},
							onCancel: () => setView({ mode: "list", accountId: null })
						})
					);
				}

				return h(
					"div",
					{ className: "dsh-balance-inquiry-page" },
					h("h2", { className: "dsh-balance-inquiry-title" }, t("settings.title")),
					h("p", { className: "dsh-balance-inquiry-desc" }, t("settings.hint")),
					h("button", { type: "button", className: "dsh-balance-inquiry-btn dsh-balance-inquiry-btn-primary", onClick: () => setPickerOpen(true) }, t("settings.add")),
					pickerOpen
						? h(AccountPicker, {
								onClose: () => setPickerOpen(false),
								onCreated: (id) => {
									setPickerOpen(false);
									setView({ mode: "account", accountId: id });
								}
							})
						: null,
					h(
						"div",
						{ className: "dsh-balance-inquiry-accounts" },
						state.accounts.length
							? state.accounts.map((account) => {
									const reading = readingOf(state, account.id);
									const item = accountValue(account, reading);
									const tone = accountTone(account, reading);
									return h(
										"button",
										{
											type: "button",
											key: account.id,
											className: "dsh-balance-inquiry-account dsh-balance-inquiry-" + tone,
											onClick: () => setView({ mode: "account", accountId: account.id })
										},
										h("span", { className: "dsh-balance-inquiry-account-name" }, account.name),
										h(
											"span",
											{ className: "dsh-balance-inquiry-account-value" },
											item ? format(t("account.line"), { value: formatValue(item.remaining, item.unit) }) : reading && reading.error ? t("account.failed") : t("account.pending")
										)
									);
								})
							: h("p", { className: "dsh-balance-inquiry-desc" }, t("settings.empty"))
					),
					h("div", { className: "dsh-balance-inquiry-sep" }),
					h("h3", { className: "dsh-balance-inquiry-title" }, t("settings.global")),
					h(
						"label",
						{ className: "dsh-balance-inquiry-field" },
						h("span", { className: "dsh-balance-inquiry-field-label" }, t("settings.interval")),
						h("input", {
							className: "dsh-balance-inquiry-input",
							type: "number",
							value: String(settings.autoQueryInterval),
							onChange: (event) => setSetting("autoQueryInterval", event.target.value)
						}),
						h("span", { className: "dsh-balance-inquiry-hint" }, t("settings.interval.hint"))
					),
					h(
						"label",
						{ className: "dsh-balance-inquiry-field" },
						h("span", { className: "dsh-balance-inquiry-field-label" }, t("settings.timeout")),
						h("input", {
							className: "dsh-balance-inquiry-input",
							type: "number",
							value: String(settings.timeoutSeconds),
							onChange: (event) => setSetting("timeoutSeconds", event.target.value)
						}),
						h("span", { className: "dsh-balance-inquiry-hint" }, t("settings.timeout.hint"))
					),
					h(
						"div",
						{ className: "dsh-balance-inquiry-row" },
						h(
							"button",
							{
								type: "button",
								className: "dsh-balance-inquiry-btn dsh-balance-inquiry-btn-primary",
								onClick: () => {
									store.saveSettings({ autoQueryInterval: settings.autoQueryInterval, timeoutSeconds: settings.timeoutSeconds });
									setSettingsDraft(null);
									setNotice(t("settings.saved"));
									const result = store.refresh();
									if (result && typeof result.catch === "function") result.catch(() => {});
								}
							},
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
						)
					),
					h("div", { className: "dsh-balance-inquiry-status" }, (notice ? notice + " ｜ " : "") + transportText())
				);
			}

			/** 余额看板：左键点卡片开这个套餐的官网地址。 */
			function Board() {
				const state = useQuotaState();
				const open = React.useSyncExternalStore
					? React.useSyncExternalStore(boardFlag.subscribe, boardFlag.get)
					: boardFlag.get();
				const pickerOpen = React.useSyncExternalStore
					? React.useSyncExternalStore(pickerFlag.subscribe, pickerFlag.get)
					: pickerFlag.get();
				const setPickerOpen = (next) => pickerFlag.set(next);
				React.useEffect(() => {
					if (!open || typeof document === "undefined" || !document.addEventListener) return;
					const onKey = (event) => {
						if (event.key === "Escape") boardFlag.set(false);
					};
					document.addEventListener("keydown", onKey);
					return () => document.removeEventListener("keydown", onKey);
				}, [open]);
				if (!open) return null;
				return h(
					"div",
					{ className: "dsh-balance-inquiry-board-mask", onClick: () => boardFlag.set(false) },
					h(
						"div",
						{
							className: "dsh-balance-inquiry-board",
							onClick: (event) => {
								try {
									event.stopPropagation();
								} catch (error) {
									// 忽略
								}
							}
						},
						h(
							"div",
							{ className: "dsh-balance-inquiry-board-head" },
							h("h2", { className: "dsh-balance-inquiry-title" }, t("board.title")),
							h(
								"div",
								{ className: "dsh-balance-inquiry-row" },
								h("button", { type: "button", className: "dsh-balance-inquiry-btn", onClick: () => setPickerOpen(!pickerOpen) }, t("board.add")),
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
									t("board.refresh")
								),
								h("button", { type: "button", className: "dsh-balance-inquiry-btn", onClick: () => boardFlag.set(false) }, t("board.close"))
							)
						),
						pickerOpen
							? h(AccountPicker, {
									onClose: () => setPickerOpen(false),
									onCreated: () => {
										setPickerOpen(false);
										const result = store.refresh();
										if (result && typeof result.catch === "function") result.catch(() => {});
									}
								})
							: null,
						state.accounts.length
							? h(
									"div",
									{ className: "dsh-balance-inquiry-board-list" },
									state.accounts.map((account) => {
										const reading = readingOf(state, account.id);
										const item = accountValue(account, reading);
										const tone = accountTone(account, reading);
										const href = account.websiteUrl || account.baseUrl || "";
										return h(
											"button",
											{
												type: "button",
												key: account.id,
												className: "dsh-balance-inquiry-card dsh-balance-inquiry-" + tone,
												title: t("board.card.tip"),
												onClick: () => {
													if (href) openExternal(href);
												}
											},
											h("span", { className: "dsh-balance-inquiry-card-name" }, account.name),
											h("span", { className: "dsh-balance-inquiry-card-value" }, item ? formatValue(item.remaining, item.unit) : reading && reading.error ? t("account.failed") : "--"),
											h(
												"span",
												{ className: "dsh-balance-inquiry-card-meta" },
												reading && reading.at ? format(t("board.card.updated"), { time: formatTime(reading.at), ago: formatRelativeTime(reading.at) }) : t("board.card.never")
											)
										);
									})
								)
							: h("p", { className: "dsh-balance-inquiry-desc" }, t("board.empty"))
					)
				);
			}

			return { QuotaEntry: QuotaEntry, SettingsPage: SettingsPage, Board: Board };
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

			ctx.slots.inject("shell.overlay", () =>
				ctx.slots.register(
					{
						name: "shell.overlay",
						id: "quota-board",
						order: ENTRY_ORDER,
						label: () => t("board.title"),
						locale: NS
					},
					() => h(components.Board, null)
				)
			);
		}

		/** 仅供自测使用：纯函数、签名与解析器。 */
		const internals = {
			/* 文案字典：自测用它逐个核对 t("…") 用到的键都有译文（漏一个界面就会显示原始键名）。 */
			dictionaries: { zh: zh, en: en },
			namespace: NS,
			defaultSettings: DEFAULT_SETTINGS,
			normalizeAccount: normalizeAccount,
			providerOptions: PROVIDER_OPTIONS,
			usesQuota: usesQuota,
			missingRequirements: missingRequirements,
			mapCurrentProvider: mapCurrentProvider,
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
