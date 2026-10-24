/**
 * 弹窗行为自测：用最小 React 替身真正调用 ProviderBindingDialog，
 * 检查渲染结果与交互回调（勾选 / 取消勾选 / 全选 / 清空 / 搜索 / 确定 / 取消）。
 *
 * 与 render_test.mjs 的区别：那个查源码结构，这个真跑组件函数。
 *
 * 运行：node dialog_test.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "lib/client.js"), "utf8");

let stateCells = [];
let hookIndex = 0;
let keyListeners = [];

const fakeReact = {
	createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
	useState: (initial) => {
		const index = hookIndex++;
		if (stateCells[index] === undefined) {
			stateCells[index] = { value: typeof initial === "function" ? initial() : initial };
		}
		const cell = stateCells[index];
		return [
			cell.value,
			(next) => {
				cell.value = typeof next === "function" ? next(cell.value) : next;
			}
		];
	},
	useEffect: (fn) => {
		fn();
	},
	useSyncExternalStore: (subscribe, get) => get()
};

const fakeDocument = {
	addEventListener: (name, handler) => {
		if (name === "keydown") keyListeners.push(handler);
	},
	removeEventListener: () => {}
};

const sandboxWindow = {
	__ModuleLoader__: {
		load: (definition) => {
			definition.factory((name) => {
				if (name === "react") return fakeReact;
				throw new Error("unexpected require: " + name);
			});
		}
	},
	localStorage: { getItem: () => null, setItem: () => {} },
	addEventListener: () => {},
	removeEventListener: () => {}
};

new Function("window", "document", "location", source)(sandboxWindow, fakeDocument, undefined);

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

function flatten(node, out = []) {
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

function findByType(tree, type) {
	return flatten(tree).filter((node) => node.type === type);
}

function textOf(node) {
	const parts = [];
	const walk = (current) => {
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

// 取出 bundle 导出的 __internals（client.js 末尾 module.exports）。
const exported = readExports();
function readExports() {
	let result = null;
	const localLoader = {
		load: (definition) => {
			result = definition.factory((name) => {
				if (name === "react") return fakeReact;
				throw new Error("unexpected require: " + name);
			});
		}
	};
	new Function("window", "document", "location", source)({ __ModuleLoader__: localLoader }, fakeDocument, undefined);
	return result;
}

const internals = exported.__internals;
// 组件在 createComponents(store, t) 里，用假 store 与「查中文字典」的 t() 建出来，
// 这样渲染出的是真实界面文案，断言可以直接核对用户看到的字。
const fakeStore = {
	getAccount: () => null,
	getState: () => ({ accounts: [], settings: {}, results: {} }),
	subscribe: () => () => {},
	onChanged: () => () => {}
};
const fakeT = (key, params) => {
	const template = internals.dictionaries.zh[key];
	if (template === undefined) return key;
	return internals.format(template, params);
};
const components = internals.createComponents(fakeStore, fakeT);
const Dialog = components.ProviderBindingDialog;
check("组件工厂里有 ProviderBindingDialog", typeof Dialog === "function");

const providers = [
	{ id: "cotton-api", displayName: "Cotton API" },
	{ id: "deepseek-official", displayName: "DeepSeek 官方" },
	{ id: "moonshot", displayName: "Moonshot" }
];

/** 挂载一个新实例：重置 hook 状态，渲染一次。 */
function mount(props) {
	hookIndex = 0;
	stateCells = [];
	keyListeners = [];
	const tree = Dialog(props);
	return {
		props,
		// 组件是纯函数 + useState，状态变化后必须重新调用一次组件函数才看得到新树。
		rerender() {
			hookIndex = 0;
			return Dialog(this.props);
		}
	};
}

/** 点击某个按钮并重新渲染，返回新树。 */
function click(instance, predicate) {
	const button = findByType(instance.rerender(), "button").find(predicate);
	if (!button) throw new Error("找不到按钮：" + predicate);
	button.props.onClick();
	return instance.rerender();
}

/** 找到复选框（每次都要从最新树里取，setState 后旧引用就过期了）。 */
function boxesOf(tree) {
	return findByType(tree, "input").filter((n) => n.props.type === "checkbox");
}

function searchInput(tree) {
	return findByType(tree, "input").find((n) => n.props.type === "search");
}

const primaryButton = (n) => String(n.props.className || "").includes("btn-primary");

// ---- 初始渲染：三行、勾选状态与 selected 一致 ----
let applied = null;
let closed = 0;
let instance = mount({
	providers,
	selected: ["moonshot"],
	currentId: "cotton-api",
	onApply: (next) => {
		applied = next;
	},
	onClose: () => {
		closed += 1;
	}
});
let tree = instance.rerender();

let labels = findByType(tree, "label");
eq("渲染出全部供应商行", labels.length, 3);
eq("行文本含显示名", labels.map((n) => textOf(n)).some((t) => t.includes("Cotton API")), true);
eq("行文本含 ID", labels.map((n) => textOf(n)).some((t) => t.includes("cotton-api")), true);

let boxes = boxesOf(tree);
eq("每行一个复选框", boxes.length, 3);
eq(
	"勾选状态跟随 selected",
	boxes.map((n) => n.props.checked),
	[false, false, true]
);

check("当前供应商有 in use 标记", textOf(tree).includes("in use") || textOf(tree).includes("当前使用中"));
eq("当前供应商标记只出现一次", findByType(tree, "span").filter((n) => String(n.props.className || "").includes("option-badge")).length, 1);
check("计数文案显示已选 1 个", /已选 1 个/.test(textOf(tree)));

// ---- 交互：勾选一个新供应商 ----
boxesOf(tree)[0].props.onChange();
tree = instance.rerender();
eq("勾选后本地草稿变成 2 个", boxesOf(tree).map((n) => n.props.checked), [true, false, true]);
tree = click(instance, primaryButton);
eq("勾选后确定交回两个 ID", applied, ["moonshot", "cotton-api"]);

// ---- 交互：取消勾选已选项 ----
applied = null;
instance = mount({
	providers,
	selected: ["moonshot"],
	currentId: "",
	onApply: (next) => {
		applied = next;
	},
	onClose: () => {}
});
tree = instance.rerender();
boxesOf(tree)[2].props.onChange();
click(instance, primaryButton);
eq("取消勾选后交回空数组", applied, []);

// ---- 交互：全选 ----
applied = null;
instance = mount({
	providers,
	selected: [],
	currentId: "",
	onApply: (next) => {
		applied = next;
	},
	onClose: () => {}
});
click(instance, (n) => textOf(n).includes("全选"));
click(instance, primaryButton);
eq("全选选中全部", applied, ["cotton-api", "deepseek-official", "moonshot"]);

// ---- 交互：清空 ----
applied = null;
instance = mount({
	providers,
	selected: ["cotton-api", "moonshot"],
	currentId: "",
	onApply: (next) => {
		applied = next;
	},
	onClose: () => {}
});
click(instance, (n) => textOf(n).includes("清空选择"));
click(instance, primaryButton);
eq("清空后交回空数组", applied, []);

// ---- 搜索过滤 ----
instance = mount({
	providers,
	selected: [],
	currentId: "",
	onApply: () => {},
	onClose: () => {}
});
tree = instance.rerender();
check("有搜索框", Boolean(searchInput(tree)));
searchInput(tree).props.onChange({ target: { value: "moon" } });
tree = instance.rerender();
labels = findByType(tree, "label");
eq("搜索按显示名过滤到一行", labels.length, 1);
check("过滤结果正确", textOf(labels[0]).includes("Moonshot"));

// 按 ID 搜索
instance = mount({
	providers,
	selected: [],
	currentId: "",
	onApply: () => {},
	onClose: () => {}
});
searchInput(instance.rerender()).props.onChange({ target: { value: "cotton" } });
eq("搜索按 ID 过滤到一行", findByType(instance.rerender(), "label").length, 1);

// 无匹配
instance = mount({
	providers,
	selected: [],
	currentId: "",
	onApply: () => {},
	onClose: () => {}
});
searchInput(instance.rerender()).props.onChange({ target: { value: "zzzz" } });
tree = instance.rerender();
eq("无匹配时没有行", findByType(tree, "label").length, 0);
check("无匹配时提示换关键词", /关键词/.test(textOf(tree)));

// ---- 空供应商列表 ----
tree = mount({
	providers: [],
	selected: [],
	currentId: "",
	onApply: () => {},
	onClose: () => {}
}).rerender();
eq("空列表没有复选框", boxesOf(tree).length, 0);
eq("空列表不显示搜索框", findByType(tree, "input").filter((n) => n.props.type === "search").length, 0);
check("空列表有引导文案", /cordis\.patch\.yml/.test(textOf(tree)));

// ---- 取消与 Esc ----
closed = 0;
instance = mount({
	providers,
	selected: [],
	currentId: "",
	onApply: () => {},
	onClose: () => {
		closed += 1;
	}
});
click(instance, (n) => textOf(n).includes("取消"));
eq("取消调用 onClose", closed, 1);
check("Esc 监听已注册", keyListeners.length > 0);
keyListeners[0]({ key: "Escape" });
eq("Esc 也调用 onClose", closed, 2);
keyListeners[0]({ key: "a" });
eq("其它键不触发关闭", closed, 2);

// ---- 草稿隔离：勾选不直接改 props.selected ----
const selectedRef = ["moonshot"];
instance = mount({
	providers,
	selected: selectedRef,
	currentId: "",
	onApply: () => {},
	onClose: () => {}
});
boxesOf(instance.rerender())[0].props.onChange();
eq("弹窗内勾选不改动传入的 selected", selectedRef, ["moonshot"]);

if (failures.length) {
	console.error("FAIL (" + failures.length + " 项未通过，共 " + (passed + failures.length) + " 项)：");
	for (const item of failures) console.error("  - " + item);
	process.exit(1);
}
console.log("PASS: " + passed + " 项弹窗行为断言全部通过");
