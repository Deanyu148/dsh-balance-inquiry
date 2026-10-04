/**
 * 把 dsh-balance-inquiry/lib/client.js 里内联的 zh / en 文案字典同步到 locale/{zh,en}.json。
 * 用法：node tools\sync-balance-locale.cjs
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const CLIENT = path.join(ROOT, "lib", "client.js");
const LOCALE = path.join(ROOT, "locale");

/** 从 source 中取出 `const <name> = { ... };` 的字面量源码（按括号配平，跳过字符串）。 */
function literalOf(source, name) {
	const marker = `const ${name} = {`;
	const start = source.indexOf(marker);
	if (start < 0) throw new Error(`找不到 const ${name}`);
	let index = start + marker.length - 1;
	let depth = 0;
	let quote = null;
	for (; index < source.length; index += 1) {
		const ch = source[index];
		if (quote !== null) {
			if (ch === "\\") index += 1;
			else if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			quote = ch;
			continue;
		}
		if (ch === "{") depth += 1;
		else if (ch === "}") {
			depth -= 1;
			if (depth === 0) return source.slice(start + marker.length - 1, index + 1);
		}
	}
	throw new Error(`const ${name} 没有闭合`);
}

const source = fs.readFileSync(CLIENT, "utf8");
for (const [name, file] of [
	["zh", "zh.json"],
	["en", "en.json"]
]) {
	const value = new Function(`return ${literalOf(source, name)};`)();
	const target = path.join(LOCALE, file);
	fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	console.log(`${file}: ${Object.keys(value).length} 条`);
}
