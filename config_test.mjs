/**
 * 自测：配置文件（config.yml + credentials.yml）的存放路径与读写。
 *
 * 直接 import 宿主半边 lib/index.js 的 __internals，用临时目录当 DSH_HOME，核对：
 *   1. 路径解析 —— 有 DSH_HOME 用它，没有就退回 ~/.dsh；
 *   2. 目录里只有 config.yml 与 credentials.yml 两个文件；
 *   3. 密钥与普通字段分开落盘，读回来又能合上；
 *   4. 局部写入不会冲掉别的分片；
 *   5. 旧的三个 JSON 分片会被迁移并删除；
 *   6. 容错 —— 坏 YAML 不炸进程、原子写不留 .tmp、类型错误回 400。
 *
 * 运行：node config_test.mjs
 */
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const host = await import(pathToFileURL(join(here, "lib/index.js")).href);
const internals = host.__internals;
const yaml = await import(pathToFileURL(join(here, "lib/yaml.js")).href);

let passed = 0;
const failures = [];

function check(label, condition) {
	if (condition) {
		passed += 1;
		return;
	}
	failures.push(label);
}

/** 把对象键递归排序后序列化：比较内容而不是键的先后顺序。 */
function canonical(value) {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object") {
		const out = {};
		for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
		return out;
	}
	return value;
}

function eq(label, actual, expected) {
	const same = JSON.stringify(canonical(actual)) === JSON.stringify(canonical(expected));
	if (same) {
		passed += 1;
		return;
	}
	failures.push(label + "\n      期望: " + JSON.stringify(expected) + "\n      实际: " + JSON.stringify(actual));
}

/** 在临时目录里跑一段，结束后删掉；不会碰到真实的 DSH_HOME。 */
function withTempHome(run) {
	const saved = process.env.DSH_HOME;
	const root = mkdtempSync(join(tmpdir(), "dbi-config-"));
	process.env.DSH_HOME = root;
	try {
		return run(root);
	} finally {
		if (saved === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = saved;
		rmSync(root, { recursive: true, force: true });
	}
}

/** 同上，但给异步用例用（HTTP 路由是 async 的）。 */
async function withTempHomeAsync(run) {
	const saved = process.env.DSH_HOME;
	const root = mkdtempSync(join(tmpdir(), "dbi-config-"));
	process.env.DSH_HOME = root;
	try {
		return await run(root);
	} finally {
		if (saved === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = saved;
		rmSync(root, { recursive: true, force: true });
	}
}

/** 只列出配置文件目录里的文件（忽略子目录）。 */
function listFiles(dir) {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => entry.name)
		.sort();
}

//#region 路径解析
withTempHome((root) => {
	eq("DSH_HOME 存在时目录是 <DSH_HOME>/dsh-balance-inquiry", internals.resolveConfigDir(), join(root, "dsh-balance-inquiry"));
});

{
	const saved = process.env.DSH_HOME;
	delete process.env.DSH_HOME;
	try {
		const dir = internals.resolveConfigDir();
		check("没有 DSH_HOME 时退回 <home>/.dsh/dsh-balance-inquiry", /[\\/]\.dsh[\\/]dsh-balance-inquiry$/.test(dir));
		check("退回路径不是空串", typeof dir === "string" && dir.length > 0);
	} finally {
		if (saved !== undefined) process.env.DSH_HOME = saved;
	}
}

withTempHome((root) => {
	process.env.DSH_HOME = "";
	eq("DSH_HOME 为空串时也退回默认目录", internals.resolveConfigDir(), join(process.env.USERPROFILE || process.env.HOME || "", ".dsh", "dsh-balance-inquiry"));
});

withTempHome((root) => {
	const spaced = join(root, "有 空格 的 目录");
	process.env.DSH_HOME = spaced;
	eq("DSH_HOME 含空格与中文也能拼对", internals.resolveConfigDir(), join(spaced, "dsh-balance-inquiry"));
});

withTempHome(() => {
	process.env.DSH_HOME = "~";
	check("DSH_HOME=~ 展开成家目录", !internals.resolveConfigDir().includes("~"));
});
//#endregion

//#region 文件名常量
eq("配置文件叫 config.yml", internals.configFile, "config.yml");
eq("密钥文件叫 credentials.yml", internals.credentialsFile, "credentials.yml");
check("密钥字段表非空", Array.isArray(internals.secretFields) && internals.secretFields.length > 0);
check("accessToken 被当作密钥", internals.secretFields.includes("accessToken"));
check("baseUrl 不算密钥", !internals.secretFields.includes("baseUrl"));
//#endregion

//#region 读写往返与两个文件
withTempHome((root) => {
	const dir = internals.resolveConfigDir();

	const empty = internals.readConfig(dir);
	eq("空目录 settings 为空对象", empty.settings, {});
	eq("空目录 accounts 为空数组", empty.accounts, []);
	eq("空目录 results 为空对象", empty.results, {});
	eq("空目录 present 全 false", empty.present, { settings: false, accounts: false, results: false });
	eq("空目录没有解析错误", empty.errors, []);
	eq("返回里说明两个文件名", empty.files, { config: "config.yml", credentials: "credentials.yml" });

	const settings = { autoQueryInterval: 15, timeoutSeconds: 20 };
	const accounts = [
		{ id: "a1", name: "套餐一", provider: "newapi", baseUrl: "https://a.example.com", accessToken: "sk-aaa", dshProviderIds: ["p1", "p2"] },
		{ id: "a2", name: "套餐二", provider: "cp-zhipu-team", organizationId: "org1", projectId: "proj1", accessToken: "sk-bbb", dshProviderIds: [] }
	];
	const results = { a1: { at: 1700000000000, stale: false, error: "", data: { success: true } } };
	const written = internals.writeConfig(dir, { settings: settings, accounts: accounts, results: results });
	eq("三个分片都写了", written.written, ["settings", "results", "accounts"]);
	eq("写入返回的目录一致", written.dir, dir);

	// 目录里只有这两个文件，没有别的。
	eq("目录里只有 config.yml 与 credentials.yml", listFiles(dir), ["config.yml", "credentials.yml"]);

	// config.yml 不含任何密钥。
	const configText = readFileSync(join(dir, "config.yml"), "utf8");
	check("config.yml 里没有 accessToken 的值", !configText.includes("sk-aaa") && !configText.includes("sk-bbb"));
	check("config.yml 里没有密钥字段名", !configText.includes("accessToken"));
	check("config.yml 里没有 organizationId", !configText.includes("organizationId"));
	check("config.yml 是 YAML（不是 JSON）", !configText.trimStart().startsWith("{"));

	// credentials.yml 按套餐 id 分组存密钥。
	const credentialsText = readFileSync(join(dir, "credentials.yml"), "utf8");
	const credentials = yaml.parse(credentialsText);
	eq("credentials.yml 按套餐 id 分组", Object.keys(credentials).sort(), ["a1", "a2"]);
	eq("a1 的密钥", credentials.a1, { accessToken: "sk-aaa" });
	eq("a2 的密钥含组织与项目", credentials.a2, { organizationId: "org1", projectId: "proj1", accessToken: "sk-bbb" });

	// 读回完全一致（密钥从 credentials.yml 合回来）。
	const back = internals.readConfig(dir);
	eq("读回 settings", back.settings, settings);
	eq("读回 accounts（含多供应商绑定与密钥）", back.accounts, accounts);
	eq("读回 results", back.results, results);
	eq("写过之后 present 全 true", back.present, { settings: true, accounts: true, results: true });
	eq("往返后没有解析错误", back.errors, []);

	// 局部写入不会冲掉别的分片。
	internals.writeConfig(dir, { settings: { autoQueryInterval: 0, timeoutSeconds: 10 } });
	const afterPartial = internals.readConfig(dir);
	eq("局部写入后 accounts 未被清空", afterPartial.accounts.length, 2);
	eq("局部写入后密钥仍在", afterPartial.accounts[0].accessToken, "sk-aaa");
	eq("局部写入后 settings 已更新", afterPartial.settings.autoQueryInterval, 0);
	eq("局部写入后 results 仍在", afterPartial.results.a1.at, 1700000000000);

	// 只改 results 也不动别的。
	internals.writeConfig(dir, { results: { a2: { at: 5 } } });
	const afterResults = internals.readConfig(dir);
	eq("只改 results 时 accounts 不变", afterResults.accounts.length, 2);
	eq("只改 results 时 settings 不变", afterResults.settings.timeoutSeconds, 10);
	eq("只改 results 时新值生效", afterResults.results.a2.at, 5);

	// 显式传空数组 = 清空，同时把不再有主子的 credentials.yml 删掉。
	internals.writeConfig(dir, { accounts: [] });
	const afterClear = internals.readConfig(dir);
	eq("显式传空数组会清空 accounts", afterClear.accounts, []);
	eq("清空 accounts 不影响 settings", afterClear.settings.timeoutSeconds, 10);
	eq("套餐清空后 credentials.yml 被删除", existsSync(join(dir, "credentials.yml")), false);
	eq("清空后目录里只剩 config.yml", listFiles(dir), ["config.yml"]);

	// 不传的分片（undefined / null）视为「不动」。
	internals.writeConfig(dir, { settings: undefined, results: null });
	eq("传 undefined / null 的分片被忽略", internals.readConfig(dir).settings.timeoutSeconds, 10);

	// 原子写：写完之后目录里不该留下 .tmp。
	eq("没有残留的 .tmp 临时文件", listFiles(dir).filter((name) => name.endsWith(".tmp")), []);

	// 目录不存在时会自己建（含多级）。
	const deep = join(root, "a", "b", "c", "dsh-balance-inquiry");
	const deepWrite = internals.writeConfig(deep, { accounts: [{ id: "x", accessToken: "sk-x" }] });
	eq("多级目录会被自动创建", deepWrite.dir, deep);
	eq("多级目录写入可读回", internals.readConfig(deep).accounts, [{ id: "x", accessToken: "sk-x" }]);
});
//#endregion

//#region 密钥分离
{
	const accounts = [
		{ id: "a1", accessToken: "t1", userId: "u1", secretAccessKey: "s1", accessKeyId: "k1", name: "n1", baseUrl: "https://x" },
		{ id: "a2", accessToken: "", name: "n2" },
		{ id: "", accessToken: "orphan", name: "没有 id" }
	];
	const split = internals.splitAccounts(accounts);
	eq("公开列表保留所有非密钥字段", Object.keys(split.accounts[0]).sort(), ["baseUrl", "id", "name"]);
	eq("密钥列表只放密钥", split.credentials.a1, { accessToken: "t1", userId: "u1", secretAccessKey: "s1", accessKeyId: "k1" });
	check("空密钥不会写进 credentials", !Object.prototype.hasOwnProperty.call(split.credentials, "a2"));
	check("没有 id 的套餐不产生密钥条目", !Object.prototype.hasOwnProperty.call(split.credentials, ""));

	// 合回来。
	const merged = internals.mergeAccounts(split.accounts, split.credentials);
	eq("合并后密钥回到 a1", merged[0].accessToken, "t1");
	check("合并后 a2 没有多余密钥", merged[1].accessToken === undefined || merged[1].accessToken === "");
	check("合并不会丢掉公开字段", merged[0].baseUrl === "https://x" && merged[0].name === "n1");

	// config.yml 里已有的字段优先（不让人手改的文件被旧密钥覆盖）。
	const overridden = internals.mergeAccounts([{ id: "a1", accessToken: "from-config" }], { a1: { accessToken: "from-credentials" } });
	eq("config.yml 里的值优先于 credentials.yml", overridden[0].accessToken, "from-config");
}
//#endregion

//#region 旧 JSON 迁移
withTempHome((root) => {
	const dir = internals.resolveConfigDir();
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "settings.json"), JSON.stringify({ autoQueryInterval: 7, timeoutSeconds: 15 }), "utf8");
	writeFileSync(join(dir, "accounts.json"), JSON.stringify([{ id: "old1", name: "旧套餐", provider: "newapi", accessToken: "sk-old", dshProviderIds: ["pX"] }]), "utf8");
	writeFileSync(join(dir, "results.json"), JSON.stringify({ old1: { at: 1, stale: false } }), "utf8");
	eq("迁移前是三个 JSON 文件", listFiles(dir), ["accounts.json", "results.json", "settings.json"]);

	const migrated = internals.migrateLegacyJson(dir);
	check("迁移报告了写入的分片", migrated && Array.isArray(migrated.written) && migrated.written.length === 3);
	eq("迁移后只剩两个 YAML 文件", listFiles(dir), ["config.yml", "credentials.yml"]);

	const back = internals.readConfig(dir);
	eq("迁移保留套餐（含密钥）", back.accounts, [{ id: "old1", name: "旧套餐", provider: "newapi", dshProviderIds: ["pX"], accessToken: "sk-old" }]);
	eq("迁移保留设置", back.settings, { autoQueryInterval: 7, timeoutSeconds: 15 });
	eq("迁移保留读数", back.results, { old1: { at: 1, stale: false } });

	// 再调一次不会重复迁移，也不会破坏已有文件。
	eq("已有 config.yml 时迁移直接返回 null", internals.migrateLegacyJson(dir), null);
	eq("重复迁移不改变内容", internals.readConfig(dir).accounts.length, 1);
});

withTempHome((root) => {
	const dir = internals.resolveConfigDir();
	mkdirSync(dir, { recursive: true });
	// 只有坏掉的旧文件：跳过，不炸，也不留下 JSON。
	writeFileSync(join(dir, "accounts.json"), "{ 不是 JSON", "utf8");
	eq("坏掉的旧 JSON 不迁移", internals.migrateLegacyJson(dir), null);
	eq("坏掉的旧 JSON 不产生 YAML", listFiles(dir), ["accounts.json"]);
});

withTempHome((root) => {
	// 完全没有旧文件时也不该创建任何东西。
	eq("没有旧文件时迁移返回 null", internals.migrateLegacyJson(internals.resolveConfigDir()), null);
	eq("没有旧文件时目录仍是空的", listFiles(internals.resolveConfigDir()), []);
});
//#endregion

//#region 类型校验与容错
withTempHome((root) => {
	const dir = internals.resolveConfigDir();
	mkdirSync(dir, { recursive: true });

	// 类型不对：settings / results 必须是对象，accounts 必须是数组。
	for (const [shard, bad] of [
		["settings", []],
		["settings", "nope"],
		["accounts", {}],
		["accounts", "nope"],
		["results", []],
		["results", 42]
	]) {
		let threw = false;
		try {
			internals.writeConfig(dir, { [shard]: bad });
		} catch (error) {
			threw = true;
		}
		check("拒绝把 " + JSON.stringify(bad) + " 写进 " + shard, threw);
	}

	// 坏 YAML：不抛错，退回空值，并记进 errors。
	writeFileSync(join(dir, "config.yml"), "accounts: [ 没有闭合\n  - : :\n", "utf8");
	const broken = internals.readConfig(dir);
	eq("坏 YAML 时 accounts 退回空数组", broken.accounts, []);
	eq("坏 YAML 被记进 errors（1 条）", broken.errors.length, 1);
	eq("errors 里带着文件名", broken.errors[0] && broken.errors[0].file, "config.yml");
	check("errors 里带着完整路径", typeof broken.errors[0].path === "string" && broken.errors[0].path.endsWith("config.yml"));
	check("errors 里带着原始报错文本", typeof broken.errors[0].message === "string" && broken.errors[0].message.length > 0);

	// 手写的合法 YAML 也能读（注释、文档头、不同缩进）。
	writeFileSync(
		join(dir, "config.yml"),
		["# 手写配置", "---", "settings:", "  autoQueryInterval: 9  # 分钟", "  timeoutSeconds: 12", "accounts:", "  - id: hand", "    name: '手写套餐'", "    dshProviderIds:", "      - p1", ""].join("\n"),
		"utf8"
	);
	const hand = internals.readConfig(dir);
	eq("手写 YAML 的设置被读出", hand.settings, { autoQueryInterval: 9, timeoutSeconds: 12 });
	eq("手写 YAML 的套餐被读出", hand.accounts, [{ id: "hand", name: "手写套餐", dshProviderIds: ["p1"] }]);
	eq("手写 YAML 不产生错误", hand.errors, []);

	// 空白文件当成「存在但里面没有任何分片」，不算解析错误。
	writeFileSync(join(dir, "config.yml"), "   \n", "utf8");
	const blank = internals.readConfig(dir);
	eq("空白 config.yml 读成空对象", blank.settings, {});
	eq("空白文件里没有 settings 分片", blank.present.settings, false);
	eq("空白文件不产生错误", blank.errors, []);
});
//#endregion

//#region YAML 读写器自身
{
	// 往返：插件真正会遇到的形状。
	const value = {
		settings: { autoQueryInterval: 5, timeoutSeconds: 10 },
		accounts: [
			{ id: "a1", name: "套餐一", provider: "newapi", baseUrl: "https://a.example.com", dshProviderIds: ["p1", "p2"], customScript: "line1\nline2" },
			{ id: "a2", name: "套餐二", provider: "deepseek", dshProviderIds: [] }
		],
		results: { a1: { at: 1700000000000, stale: false } }
	};
	eq("YAML 往返一致", yaml.parse(yaml.stringify(value)), value);

	// 各种会被写成引号的字符串都要能读回原文。
	for (const text of ["123", "true", "null", "~", "a: b", "x #y", "- dash", "", "  padded  ", "tab\there", "multi\nline", "multi\nline\n", "quote'here", 'quote"here', "back\\slash", "中文值", "1.5e10"]) {
		eq("字符串 " + JSON.stringify(text) + " 往返一致", yaml.parse(yaml.stringify({ k: text })), { k: text });
	}

	// 标量类型。
	eq("布尔保持布尔", yaml.parse(yaml.stringify({ a: true, b: false })), { a: true, b: false });
	eq("数字保持数字", yaml.parse(yaml.stringify({ a: 1.5, b: -2, c: 0 })), { a: 1.5, b: -2, c: 0 });
	eq("null 保持 null", yaml.parse(yaml.stringify({ a: null })), { a: null });

	// 读别人手写的 YAML。
	eq("能读注释与文档头", yaml.parse("# c\n---\na: 1\n"), { a: 1 });
	eq("能读折叠块", yaml.parse("a: >-\n  one\n  two\n"), { a: "one two" });
	eq("能读保留换行的块", yaml.parse("a: |\n  one\n"), { a: "one\n" });
	eq("能读空数组", yaml.parse("a: []\n"), { a: [] });
	eq("能读空对象", yaml.parse("a: {}\n"), { a: {} });
	eq("能读引号键", yaml.parse("'a b': 1\n"), { "a b": 1 });
	eq("能读 CRLF", yaml.parse("a: 1\r\nb: 2\r\n"), { a: 1, b: 2 });
	eq("能读 BOM", yaml.parse("\uFEFFa: 1\n"), { a: 1 });
	eq("能读四空格缩进", yaml.parse("a:\n    b: 1\n"), { a: { b: 1 } });
	eq("空文档读成 null", yaml.parse(""), null);
	eq("只有注释读成 null", yaml.parse("# nothing\n"), null);

	// 不支持的语法要明确报错，而不是静默读错。
	let anchorThrew = false;
	try {
		yaml.parse("a: &x 1\n");
	} catch (error) {
		anchorThrew = true;
	}
	check("锚点语法明确报错", anchorThrew);

	// 生成的文本要长得像手写 YAML（序列项用 `- ` 起头，不是 JSON）。
	const text = yaml.stringify({ accounts: [{ id: "a1", name: "n" }] });
	check("序列项是 `- ` 起头", /\n {2}- id: a1/.test(text));
	check("顶层不带大括号", !text.trimStart().startsWith("{"));
}
//#endregion

//#region HTTP 路由（用假 request / response 直调 handler）
function fakeRequest(method, cookie, body) {
	const listeners = new Map();
	const text = body === undefined ? "" : JSON.stringify(body);
	const request = {
		method: method,
		headers: cookie ? { cookie: cookie } : {},
		on(event, handler) {
			if (!listeners.has(event)) listeners.set(event, []);
			listeners.get(event).push(handler);
			return request;
		},
		destroy() {}
	};
	setImmediate(() => {
		if (text) for (const handler of listeners.get("data") || []) handler(Buffer.from(text, "utf8"));
		for (const handler of listeners.get("end") || []) handler();
	});
	return request;
}

function fakeResponse() {
	const captured = { status: 0, headers: null, body: "" };
	const response = {
		writeHead(status, headers) {
			captured.status = status;
			captured.headers = headers || null;
			return response;
		},
		end(text) {
			captured.body = text === undefined || text === null ? "" : String(text);
		}
	};
	return {
		response,
		json() {
			try {
				return JSON.parse(captured.body);
			} catch (error) {
				return null;
			}
		},
		headers: () => captured.headers,
		status: () => captured.status
	};
}

async function callConfig(method, cookie, body) {
	const fake = fakeResponse();
	await internals.handleConfig(fakeRequest(method, cookie, body), fake.response);
	return { status: fake.status(), headers: fake.headers(), json: fake.json() };
}

await withTempHomeAsync(async () => {
	const denied = await callConfig("GET", "", undefined);
	eq("没有会话 cookie 时 GET 被拒（403）", denied.status, 403);
	eq("被拒时 ok 为 false", denied.json && denied.json.ok, false);
	check("被拒时错误信息说明缺 cookie", /cookie/i.test(String(denied.json && denied.json.error && denied.json.error.message)));
	eq("被拒的请求不会创建目录", existsSync(internals.resolveConfigDir()), false);

	const empty = await callConfig("GET", "dsh_session=1", undefined);
	eq("带 cookie 的 GET 成功（200）", empty.status, 200);
	eq("GET 返回 ok=true", empty.json && empty.json.ok, true);
	eq("GET 返回配置文件目录", empty.json && empty.json.dir, internals.resolveConfigDir());
	eq("GET 返回空的 accounts", empty.json && empty.json.accounts, []);
	eq("GET 返回两个文件名", empty.json && empty.json.files, { config: "config.yml", credentials: "credentials.yml" });
	check("GET 响应禁止缓存", /no-store/.test(String(empty.headers && empty.headers["cache-control"])));

	const accounts = [{ id: "a1", name: "套餐一", dshProviderIds: ["p1", "p2"], accessToken: "sk-http" }];
	const post = await callConfig("POST", "dsh_session=1", { accounts: accounts, settings: { autoQueryInterval: 3, timeoutSeconds: 12 } });
	eq("POST 成功（200）", post.status, 200);
	eq("POST 报告写了哪些分片", post.json && post.json.written, ["settings", "accounts"]);

	const again = await callConfig("GET", "dsh_session=1", undefined);
	eq("HTTP 往返后 accounts 一致", again.json && again.json.accounts, accounts);
	eq("HTTP 往返后 settings 一致", again.json && again.json.settings, { autoQueryInterval: 3, timeoutSeconds: 12 });
	eq("HTTP 往返后 present 正确", again.json && again.json.present, { settings: true, accounts: true, results: false });
	eq("HTTP 写入后目录里只有两个文件", listFiles(internals.resolveConfigDir()), ["config.yml", "credentials.yml"]);

	const put = await callConfig("PUT", "dsh_session=1", {});
	eq("PUT 被拒（405）", put.status, 405);

	const options = await callConfig("OPTIONS", "", undefined);
	eq("OPTIONS 返回 204", options.status, 204);
	check("OPTIONS 带回 CORS 头", String((options.headers && options.headers["access-control-allow-methods"]) || "").includes("POST"));

	const bad = await callConfig("POST", "dsh_session=1", { accounts: { nope: true } });
	eq("写入类型错误时回 400", bad.status, 400);
	eq("类型错误时 ok=false", bad.json && bad.json.ok, false);
	eq("类型错误后原 accounts 未被破坏", (await callConfig("GET", "dsh_session=1", undefined)).json.accounts.length, 1);
});
//#endregion

//#region 客户端也认识这两个文件
{
	const clientSource = readFileSync(join(here, "lib/client.js"), "utf8");
	check("客户端有 /config 路由常量", clientSource.includes('"/plugins/dsh-balance-inquiry/config"'));
	check("客户端启动时会 hydrate 宿主配置", /hydrate\s*\(/.test(clientSource));
	check("客户端把设置写回宿主", /writeConfigToHost\(\s*\{\s*settings:/.test(clientSource));
	check("客户端把套餐写回宿主", /writeConfigToHost\(\s*\{\s*accounts:/.test(clientSource));
	check("客户端把读数写回宿主", /writeConfigToHost\(\s*\{\s*results:/.test(clientSource));
	check("localStorage 仍作为兜底保留", /window\.localStorage\.getItem/.test(clientSource));
	check("首次启动会把老配置迁移到文件", /migrate\[|migrate\./.test(clientSource));
	check("注释里写明 config.yml", clientSource.includes("config.yml"));
	check("注释里写明 credentials.yml", clientSource.includes("credentials.yml"));
	check("不再提到旧的三个 JSON 分片", !/settings\.json|accounts\.json|results\.json/.test(clientSource));
}
{
	const hostSource = readFileSync(join(here, "lib/index.js"), "utf8");
	check("宿主端不再写 JSON 分片", !/JSON\.stringify\(value, null, 2\)/.test(hostSource));
	check("宿主端引用 yaml 模块", /from "\.\/yaml\.js"/.test(hostSource));
	check("宿主端有迁移旧 JSON 的函数", /function migrateLegacyJson/.test(hostSource));
}
{
	// 发布到 npm 时 files 白名单漏掉 yaml.js 的话，装上去会直接加载失败。
	const manifest = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));
	check("package.json 的 files 里带上了 lib/yaml.js", Array.isArray(manifest.files) && manifest.files.includes("lib/yaml.js"));
	check("插件仍然零运行时依赖", !manifest.dependencies || !Object.keys(manifest.dependencies).length);
}
//#endregion

if (failures.length) {
	console.error("FAIL (" + failures.length + " 项未通过，共 " + (passed + failures.length) + " 项)：");
	for (const item of failures) console.error("  - " + item);
	process.exit(1);
}
console.log("PASS: " + passed + " 项配置文件断言全部通过");
