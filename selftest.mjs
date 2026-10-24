/**
 * 自测：在 Node 里加载客户端 bundle 的 __internals，逐条断言多供应商绑定。
 *
 * bundle 的格式是 window.__ModuleLoader__.load({ id, factory })，factory 需要一个
 * 极简的 require 来取 react。这里给一个只够用的替身，只为把 __internals 拿出来。
 *
 * 运行：node selftest.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "lib/client.js"), "utf8");

let captured = null;
const fakeReact = {
	createElement: () => null,
	useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
	useEffect: () => {},
	useSyncExternalStore: (subscribe, get) => get()
};
const sandboxWindow = {
	__ModuleLoader__: {
		load: (definition) => {
			captured = definition.factory((name) => {
				if (name === "react") return fakeReact;
				throw new Error("unexpected require: " + name);
			});
		}
	},
	localStorage: {
		store: new Map(),
		getItem(key) {
			return this.store.has(key) ? this.store.get(key) : null;
		},
		setItem(key, value) {
			this.store.set(key, String(value));
		}
	},
	addEventListener: () => {},
	removeEventListener: () => {}
};

// 用 Function 构造一个带 window 的最小全局环境来执行 bundle。
new Function("window", "document", "location", source)(sandboxWindow, undefined, undefined);

if (!captured || !captured.__internals) {
	console.error("FAIL: 没能从 bundle 里取到 __internals");
	process.exit(1);
}

const internals = captured.__internals;
const { normalizeProviderIds, providerIdsOf, providerIdMatches, accountMatchesProvider, normalizeAccount, dictionaries } = internals;

let passed = 0;
const failures = [];

function check(label, condition) {
	if (condition) {
		passed += 1;
		return;
	}
	failures.push(label);
}

function eq(label, actual, expected) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	check(label + " (got " + a + ", want " + e + ")", a === e);
}

//#region normalizeProviderIds
eq("数组去重保序", normalizeProviderIds(["b", "a", "b"], ""), ["b", "a"]);
eq("数组去空白项", normalizeProviderIds([" a ", "", "  ", "b"], ""), ["a", "b"]);
eq("字符串按逗号拆", normalizeProviderIds("a,b", ""), ["a", "b"]);
eq("字符串按空格拆", normalizeProviderIds("a b", ""), ["a", "b"]);
eq("字符串按分号拆", normalizeProviderIds("a;b", ""), ["a", "b"]);
eq("字符串混合分隔符", normalizeProviderIds(" a , b;c  d ", ""), ["a", "b", "c", "d"]);
eq("空字符串 + 旧值兜底", normalizeProviderIds("", "legacy"), ["legacy"]);
eq("数组非空时不使用旧值", normalizeProviderIds(["x"], "legacy"), ["x"]);
eq("undefined 用旧值", normalizeProviderIds(undefined, "legacy"), ["legacy"]);
eq("全空得到空数组", normalizeProviderIds([], ""), []);
eq("null 得到空数组", normalizeProviderIds(null, null), []);
eq("非字符串非数组得到空数组", normalizeProviderIds(42, ""), []);
//#endregion

//#region providerIdsOf
eq("providerIdsOf 读数组", providerIdsOf({ dshProviderIds: ["a", "b"] }), ["a", "b"]);
eq("providerIdsOf 兼容旧单值", providerIdsOf({ dshProviderId: "old" }), ["old"]);
eq("providerIdsOf 空对象", providerIdsOf({}), []);
eq("providerIdsOf null", providerIdsOf(null), []);
//#endregion

//#region providerIdMatches
check("同 ID 匹配", providerIdMatches("cottonapi", "cottonapi") === true);
check("不同 ID 不匹配", providerIdMatches("cottonapi", "other") === false);
check("official 与 account 互通", providerIdMatches("deepseek-official", "deepseek-account") === true);
check("account 与 official 互通", providerIdMatches("deepseek-account", "deepseek-official") === true);
check("空绑定不匹配", providerIdMatches("", "cottonapi") === false);
check("空当前不匹配", providerIdMatches("cottonapi", "") === false);
//#endregion

//#region accountMatchesProvider
check(
	"多绑定命中第一个",
	accountMatchesProvider({ dshProviderIds: ["a", "b"] }, "a") === true
);
check(
	"多绑定命中第二个",
	accountMatchesProvider({ dshProviderIds: ["a", "b"] }, "b") === true
);
check(
	"多绑定都不命中",
	accountMatchesProvider({ dshProviderIds: ["a", "b"] }, "c") === false
);
check(
	"旧单值仍能命中",
	accountMatchesProvider({ dshProviderId: "old" }, "old") === true
);
check("未绑定不命中", accountMatchesProvider({ dshProviderIds: [] }, "a") === false);
check("空当前不命中", accountMatchesProvider({ dshProviderIds: ["a"] }, "") === false);
//#endregion

//#region normalizeAccount
const migrated = normalizeAccount({ id: "x", name: "n", provider: "newapi", dshProviderId: "old-provider" });
eq("旧单值迁移成数组", migrated.dshProviderIds, ["old-provider"]);
check("迁移后不再保留 dshProviderId 字段", migrated.dshProviderId === undefined);

const multi = normalizeAccount({ id: "y", name: "n", provider: "newapi", dshProviderIds: ["a", "b", "a"] });
eq("多值去重", multi.dshProviderIds, ["a", "b"]);

const empty = normalizeAccount({ id: "z", name: "n", provider: "newapi" });
eq("未绑定是空数组", empty.dshProviderIds, []);

const both = normalizeAccount({ id: "w", name: "n", provider: "newapi", dshProviderIds: ["a"], dshProviderId: "old" });
eq("新字段优先于旧字段", both.dshProviderIds, ["a"]);
check("normalizeAccount 输出可 JSON 往返", JSON.stringify(normalizeAccount(JSON.parse(JSON.stringify(both))).dshProviderIds) === '["a"]');
//#endregion

//#region 字典完整性
const zhKeys = Object.keys(dictionaries.zh).sort();
const enKeys = Object.keys(dictionaries.en).sort();
eq("中英字典键集合一致", zhKeys, enKeys);

const required = [
	"form.dshProvider",
	"form.dshProvider.none",
	"form.dshProvider.hint",
	"form.dshProvider.pick",
	"form.dshProvider.edit",
	"form.dshProvider.clear",
	"form.dshProvider.remove",
	"form.dshProvider.dialog.title",
	"form.dshProvider.dialog.desc",
	"form.dshProvider.dialog.search",
	"form.dshProvider.dialog.selectAll",
	"form.dshProvider.dialog.clear",
	"form.dshProvider.dialog.count",
	"form.dshProvider.dialog.current",
	"form.dshProvider.dialog.empty",
	"form.dshProvider.dialog.emptySearch",
	"form.dshProvider.dialog.ok",
	"form.dshProvider.dialog.cancel"
];
for (const key of required) {
	check("zh 有 " + key, typeof dictionaries.zh[key] === "string" && dictionaries.zh[key].length > 0);
	check("en 有 " + key, typeof dictionaries.en[key] === "string" && dictionaries.en[key].length > 0);
}
//#endregion

//#region 源码级守卫：t("…") 用到的键必须在两套字典里都有
// 先把注释整段剥掉，否则文档注释里举例的 t("…") 会被当成真实调用。
const code = source
	.replace(/\/\*[\s\S]*?\*\//g, "")
	.split("\n")
	.map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
	.join("\n");

const usedKeys = new Set();
for (const match of code.matchAll(/\bt\(\s*"([^"]+)"\s*\)/g)) usedKeys.add(match[1]);
// 三元表达式里的 t(cond ? "a" : "b") 也要算进去。
for (const match of code.matchAll(/\bt\(\s*[^)]*?\?\s*"([^"]+)"\s*:\s*"([^"]+)"\s*\)/g)) {
	usedKeys.add(match[1]);
	usedKeys.add(match[2]);
}
// 动态键（t(isVolc ? "a" : "b") 之外的拼接）不算漏翻。
const dynamic = [...usedKeys].filter((key) => key.includes("…") || key.includes("${"));
for (const key of dynamic) usedKeys.delete(key);
check("源码里确实扫到了文案键（守卫自身有效）", usedKeys.size > 30);
const missingZh = [...usedKeys].filter((key) => typeof dictionaries.zh[key] !== "string").sort();
const missingEn = [...usedKeys].filter((key) => typeof dictionaries.en[key] !== "string").sort();
eq("没有漏翻的中文键", missingZh, []);
eq("没有漏翻的英文键", missingEn, []);
//#endregion

//#region locale/*.json 必须与内联字典逐键一致
// README 里写明「同一份也内联在 client.js 里」，两份一旦漂移，发布出去的 locale 就是旧文案。
for (const lang of ["zh", "en"]) {
	const json = JSON.parse(readFileSync(join(here, "locale", lang + ".json"), "utf8"));
	const inline = dictionaries[lang];
	eq("locale/" + lang + ".json 键集合与内联字典一致", Object.keys(json).sort(), Object.keys(inline).sort());
	const drift = Object.keys(inline).filter((key) => json[key] !== inline[key]);
	eq("locale/" + lang + ".json 文案与内联字典一致", drift, []);
}
//#endregion

//#region 没有残留的旧字段引用
// 只允许 providerIdsOf / normalizeAccount 里读旧单值做兼容；别处不许再按单值匹配。
check("表单不再写单值 draft.dshProviderId", !/draft\.dshProviderId(?!s)/.test(code));
check("不再用 === account.dshProviderId 直接比较", !/===\s*account\.dshProviderId\b/.test(code));
check("匹配走 accountMatchesProvider", /accountMatchesProvider\(/.test(code));
check("旧单值只在 providerIdsOf 里兜底", (code.match(/\baccount\.dshProviderId\b/g) || []).length <= 2);
check("normalizeAccount 会把旧单值删掉", /delete\s+account\.dshProviderId/.test(code));
//#endregion

if (failures.length) {
	console.error("FAIL (" + failures.length + " 项未通过，共 " + (passed + failures.length) + " 项)：");
	for (const item of failures) console.error("  - " + item);
	process.exit(1);
}
console.log("PASS: " + passed + " 项断言全部通过");
