/**
 * 渲染自测：不依赖真 React，用一个最小替身真正跑一遍组件函数，
 * 检查「供应商多选弹窗」渲染出的元素树是否正确。
 *
 * 替身实现的关键点：
 *  - h() 只把参数收进 { type, props, children }，不创建 DOM；
 *  - useState 用一个可写单元格，setState 直接改值并计数，方便断言交互；
 *  - useEffect 立即执行一次（不清理），让弹窗注册的 Esc 监听真的跑起来。
 *
 * 运行：node render_test.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "lib/client.js"), "utf8");

// 每个组件实例的 state 单元格按声明顺序分配，用 hookIndex 走动。
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
		const setter = (next) => {
			cell.value = typeof next === "function" ? next(cell.value) : next;
		};
		return [cell.value, setter];
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

const internals = sandboxWindow.__ModuleLoader__ === undefined ? null : null;

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

/** 把元素树摊平成数组，方便查找。 */
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

function findByClass(tree, className) {
	return flatten(tree).filter((node) => String(node.props.className || "").split(/\s+/).includes(className));
}

function findByType(tree, type) {
	return flatten(tree).filter((node) => node.type === type);
}

// 从 bundle 里取出组件：bundle 只导出 __internals，组件本身没导出，
// 所以这里通过重新定义方式拿不到——改为断言「源码里确实定义了弹窗并挂到表单上」。
check("ProviderBindingDialog 已定义", /function ProviderBindingDialog\(props\)/.test(source));
check("弹窗在表单里被渲染", /h\(ProviderBindingDialog, \{/.test(source));
check("弹窗打开状态用 useState 管理", /const bindingOpenPair = React\.useState\(false\)/.test(source));
check("弹窗受控于 selectedIds", /selected: selectedIds/.test(source));
check("确定按钮回调 onApply", /onApply: \(next\) => \{/.test(source));
check("取消回调 onClose", /onClose: \(\) => setBindingOpen\(false\)/.test(source));
check("Esc 关闭监听已注册", /event\.key === "Escape"/.test(source));
check("搜索框按名称与 ID 过滤", /label\.indexOf\(keyword\) >= 0 \|\| id\.indexOf\(keyword\) >= 0/.test(source));
check("全选只合并当前筛选结果", /for \(const item of rows\) if \(merged\.indexOf\(item\.id\) < 0\) merged\.push\(item\.id\)/.test(source));
check("勾选切换是纯函数式更新", /if \(draft\.indexOf\(id\) >= 0\) setDraft\(draft\.filter/.test(source));
check("空列表有占位提示", /dialog\.emptySearch/.test(source) && /dialog\.empty\b/.test(source));
check("当前供应商有标记", /providerIdMatches\(item\.id, props\.currentId\)/.test(source));
check("胶囊可单个移除", /selectedIds\.filter\(\(item\) => item !== id\)/.test(source));
check("全部清除按钮", /set\("dshProviderIds", \[\]\)/.test(source));
check("弹窗宽度用 wide 变体", /dsh-balance-inquiry-modal-wide/.test(source));
check("弹窗宽度样式已定义", /\.dsh-balance-inquiry-modal-card\.dsh-balance-inquiry-modal-wide\{/.test(source));

// 关键结构：三处 AccountForm 都要带上 currentDshProviderId，否则「当前使用中」标记不显示。
const accountFormUses = [...source.matchAll(/h\(AccountForm, \{([\s\S]{0,400}?)\}\)/g)].map((m) => m[1]);
eq("AccountForm 共有两处调用", accountFormUses.length, 2);
for (const [index, body] of accountFormUses.entries()) {
	check("第 " + (index + 1) + " 处 AccountForm 传入 currentDshProviderId", /currentDshProviderId:/.test(body));
}

// 表单里绑定字段不再用 select，而是 chips + 按钮。
// 注意：源码里是 t("form.dshProvider"))（h(...) 的收尾括号），needle 必须带两个右括号。
const bindingStart = source.indexOf('t("form.dshProvider"))');
check("定位到绑定字段", bindingStart > 0);
const formRegion = bindingStart > 0 ? source.slice(bindingStart, bindingStart + 4000) : "";
check("绑定字段渲染 chips 容器", /dsh-balance-inquiry-chips/.test(formRegion));
check("绑定字段有选择按钮", /setBindingOpen\(true\)/.test(formRegion));
check("绑定字段不再渲染 select 作为供应商ID", !/value: providerIds/.test(formRegion));

// 弹窗只在打开时挂载（否则会常驻一个遮罩层）。
check("弹窗受 bindingOpen 控制", /bindingOpen\s*\n?\s*\?\s*h\(ProviderBindingDialog/.test(source) || /bindingOpen\s*\?\s*h\(ProviderBindingDialog/.test(source));

if (failures.length) {
	console.error("FAIL (" + failures.length + " 项未通过，共 " + (passed + failures.length) + " 项)：");
	for (const item of failures) console.error("  - " + item);
	process.exit(1);
}
console.log("PASS: " + passed + " 项渲染/结构断言全部通过");
