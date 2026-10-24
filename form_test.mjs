/**
 * 设置页表单自测：真正渲染 AccountForm 所在的可视区域，
 * 核对「供应商ID」这一栏从下拉框变成了 chips + 打开弹窗的按钮。
 *
 * 运行：node form_test.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "lib/client.js"), "utf8");

let stateCells = new Map();
let hookIndex = 0;
let currentOwner = "root";

const fakeReact = {
	createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
	useState: (initial) => {
		const key = currentOwner + "#" + hookIndex++;
		if (!stateCells.has(key)) stateCells.set(key, { value: typeof initial === "function" ? initial() : initial });
		const cell = stateCells.get(key);
		return [cell.value, (next) => { cell.value = typeof next === "function" ? next(cell.value) : next; }];
	},
	useEffect: (fn) => fn(),
	useSyncExternalStore: (subscribe, get) => get()
};

const fakeDocument = { addEventListener: () => {}, removeEventListener: () => {} };

let exported = null;
const loader = {
	load: (definition) => {
		exported = definition.factory((name) => {
			if (name === "react") return fakeReact;
			throw new Error("unexpected require: " + name);
		});
	}
};
new Function("window", "document", "location", source)(
	{ __ModuleLoader__: loader, localStorage: { getItem: () => null, setItem: () => {} }, addEventListener: () => {}, removeEventListener: () => {} },
	fakeDocument,
	undefined
);

let passed = 0;
const failures = [];
function check(label, condition) {
	if (condition) passed += 1;
	else failures.push(label);
}
function eq(label, actual, expected) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	check(label + " (got " + a + ", want " + e + ")", a === e);
}

/** 展开函数组件（AccountForm 等），否则拿不到表单里的 input。 */
function expand(node) {
	if (node === null || node === undefined || node === false || node === true) return node;
	if (Array.isArray(node)) return node.map(expand);
	if (typeof node !== "object" || !node.type) return node;
	if (typeof node.type === "function") {
		const owner = currentOwner;
		const index = hookIndex;
		currentOwner = node.type.name || "anonymous";
		hookIndex = 0;
		const rendered = node.type(node.props);
		currentOwner = owner;
		hookIndex = index;
		return expand(rendered);
	}
	return Object.assign({}, node, { children: (node.children || []).map(expand) });
}

function flatten(node, out = []) {
	node = expand(node);
	if (node === null || node === undefined || node === false) return out;
	if (Array.isArray(node)) {
		for (const item of node) flatten(item, out);
		return out;
	}
	if (typeof node === "object" && node.type) {
		out.push(node);
		for (const child of node.children || []) flatten(child, out);
	}
	return out;
}
function textOf(node) {
	const parts = [];
	const walk = (current) => {
		current = expand(current);
		if (current === null || current === undefined || current === false) return;
		if (typeof current === "string" || typeof current === "number") {
			parts.push(String(current));
			return;
		}
		if (Array.isArray(current)) {
			current.forEach(walk);
			return;
		}
		(current.children || []).forEach(walk);
	};
	walk(node);
	return parts.join("");
}

const internals = exported.__internals;
const t = (key, params) => internals.format(internals.dictionaries.zh[key] ?? key, params);

// 一个最小的 store：只提供 SettingsPage 渲染时会读的接口。
// settingsView / pickerFlag 是模块级 observable，测试里直接用它的 set 切视图。
let accounts = [];
const store = {
	getState: () => ({ accounts, settings: internals.defaultSettings, results: {}, currentDshProviderId: "cotton-api" }),
	getAccounts: () => accounts,
	subscribe: () => () => {},
	onChanged: () => () => {},
	getAccount: (id) => accounts.find((item) => item.id === id) || null,
	settings: internals.defaultSettings,
	addAccount: (draft) => {
		const account = internals.normalizeAccount(Object.assign({ id: "new-id" }, draft));
		accounts = accounts.concat([account]);
		return account;
	},
	updateAccount: (id, draft) => {
		accounts = accounts.map((item) => (item.id === id ? internals.normalizeAccount(Object.assign({}, item, draft)) : item));
	},
	removeAccount: (id) => {
		accounts = accounts.filter((item) => item.id !== id);
	},
	refresh: () => {},
	refreshAll: () => {},
	refreshAccount: () => {},
	getReading: () => null
};

const components = internals.createComponents(store, t);

function renderSettings() {
	hookIndex = 0;
	stateCells = new Map();
	return components.SettingsPage();
}

/**
 * 进入「编辑已有套餐」页：设置页的 AccountForm 只在 view.mode === "account" 时渲染。
 * 这个视图是模块级 observable，自测里没有暴露，所以直接改 store 里的账号再用
 * 真实入口（列表页的编辑按钮）进去。
 */
function openAccountEditor() {
	let tree = renderSettings();
	const buttons = () => flatten(tree).filter((n) => n.type === "button");
	// settingsView 是模块级状态：上一次测试可能停在编辑页，先退回列表。
	const back = buttons().find((n) => textOf(n) === "返回列表");
	if (back) {
		back.props.onClick();
		tree = renderSettings();
	}
	const button = buttons().find((n) => String(n.props.className || "").split(/\s+/).includes("dsh-balance-inquiry-account"));
	if (!button) {
		throw new Error("找不到账号卡片入口，按钮：" + JSON.stringify(buttons().map(textOf)));
	}
	button.props.onClick();
	hookIndex = 0;
	return components.SettingsPage();
}

// ---- 列表页 ----
let tree = renderSettings();
check("设置页渲染成功", Boolean(tree));
check("列表页有新增按钮", flatten(tree).some((n) => n.type === "button" && /新增|添加/.test(textOf(n))));

// ---- 已有套餐：进入编辑页（AccountForm 只在这里渲染）----
accounts = [
	internals.normalizeAccount({
		id: "a1",
		name: "套餐A",
		provider: "newapi",
		dshProviderIds: ["cotton-api", "moonshot"]
	})
];
hookIndex = 0;
stateCells = new Map();
tree = openAccountEditor();
const all = flatten(tree);
check("编辑页渲染出输入框", all.filter((n) => n.type === "input").length > 3);

const formText = textOf(tree);
check("表单里出现「供应商ID」标签", formText.includes("供应商ID"));
check("表单提示可以多选", /可以同时绑定多个/.test(formText));
check("有「选择供应商」按钮", all.some((n) => n.type === "button" && textOf(n).includes("选择供应商")));

// 关键：这一栏不再是 <select>
const selects = all.filter((n) => n.type === "select");
const selectLabels = selects.map((n) => textOf(n));
check("供应商ID 不再是下拉框", !selectLabels.some((label) => label.includes("不设置") && label.includes("deepseek")));

// 弹窗默认不挂载
check("弹窗默认不渲染", !all.some((n) => String(n.props.className || "").includes("dsh-balance-inquiry-modal")));

// ---- 点开弹窗 ----
const openButton = all.find((n) => n.type === "button" && textOf(n).includes("选择供应商"));
openButton.props.onClick();
hookIndex = 0;
tree = components.SettingsPage();
const withDialog = flatten(tree);
check("点开后弹窗挂载", withDialog.some((n) => String(n.props.className || "").includes("dsh-balance-inquiry-modal")));
check("弹窗有标题", textOf(tree).includes("选择要绑定的供应商"));
check("弹窗有确定按钮", withDialog.some((n) => n.type === "button" && textOf(n).includes("确定")));
check("弹窗有取消按钮", withDialog.some((n) => n.type === "button" && textOf(n).includes("取消")));

// ---- 已有绑定的展示：chips + 单独移除 ----
hookIndex = 0;
stateCells = new Map();
tree = openAccountEditor();
{
	const editAll = flatten(tree);
	const chips = editAll.filter((n) => String(n.props.className || "").split(/\s+/).includes("dsh-balance-inquiry-chip"));
	eq("已绑定的两个供应商各一个胶囊", chips.length, 2);
	const removeButtons = editAll.filter((n) => String(n.props.className || "").includes("chip-remove"));
	eq("每个胶囊都有移除按钮", removeButtons.length, 2);
	check("编辑页显示「全部清除」", editAll.some((n) => n.type === "button" && textOf(n).includes("全部清除")));
	check("编辑页按钮显示已选数量", editAll.some((n) => n.type === "button" && /已选 2 个/.test(textOf(n))));

	// 点移除
	removeButtons[0].props.onClick();
	hookIndex = 0;
	tree = components.SettingsPage();
	const afterRemove = flatten(tree).filter((n) => String(n.props.className || "").split(/\s+/).includes("dsh-balance-inquiry-chip"));
	eq("移除一个后剩一个胶囊", afterRemove.length, 1);
}

if (failures.length) {
	console.error("FAIL (" + failures.length + " 项未通过，共 " + (passed + failures.length) + " 项)：");
	for (const item of failures) console.error("  - " + item);
	process.exit(1);
}
console.log("PASS: " + passed + " 项设置页表单断言全部通过");
