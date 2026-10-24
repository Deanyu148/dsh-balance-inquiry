/**
 * 极简 YAML 读写。
 *
 * 插件只用 YAML 存两类东西：全局设置（扁平对象）和套餐列表（对象数组），
 * 外加少量可能含换行的字符串（自定义用量脚本）。为此引一个完整的 YAML 库
 * 不值得——插件装进 profile 的 node_modules 后要保证零运行时依赖，所以这里
 * 只实现这个子集：
 *
 *   写：块状映射 / 块状序列 / 标量（普通、单引号、双引号、多行 `|`）。
 *   读：上面这些，加上注释、`---` 文档头、`> ` 折叠块、空数组 `[]`、空对象 `{}`。
 *
 * 不支持锚点、别名、标签、流式集合、多文档——读到这些会明确报错，而不是
 * 悄悄解析成错误的值。
 */

/** 看起来像数字的字符串必须加引号，否则读回来会变成 number。 */
const NUMBER_LIKE = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
const SPECIAL_LIKE = /^(true|false|null|~|yes|no|on|off)$/i;
/** 这些字符开头的普通标量在 YAML 里有特殊含义，一律加引号。 */
const BAD_START = /^[-?:,[\]{}#&*!|>'"%@`]/;

function isPlainSafe(text) {
	if (typeof text !== "string" || text.length === 0) return false;
	if (/[\u0000-\u001f\u007f]/.test(text)) return false;
	if (text !== text.trim()) return false;
	if (BAD_START.test(text)) return false;
	if (text.includes(": ") || text.endsWith(":")) return false;
	if (/\s#/.test(text)) return false;
	if (NUMBER_LIKE.test(text) || SPECIAL_LIKE.test(text)) return false;
	return true;
}

/** 单引号标量：只需把 `'` 写成 `''`，反斜杠等字符保持字面量。 */
function singleQuote(text) {
	return `'${text.replace(/'/g, "''")}'`;
}

function doubleQuote(text) {
	let out = '"';
	for (const ch of text) {
		switch (ch) {
			case '"':
				out += '\\"';
				break;
			case "\\":
				out += "\\\\";
				break;
			case "\n":
				out += "\\n";
				break;
			case "\r":
				out += "\\r";
				break;
			case "\t":
				out += "\\t";
				break;
			default: {
				const code = ch.codePointAt(0);
				out += code < 0x20 || code === 0x7f ? "\\u" + code.toString(16).padStart(4, "0") : ch;
			}
		}
	}
	return out + '"';
}

/** 单行标量（字符串 / 数字 / 布尔 / null）。 */
function formatScalar(value) {
	if (value === null || value === undefined) return "null";
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") {
		if (!Number.isFinite(value)) return doubleQuote(String(value));
		return String(value);
	}
	const text = String(value);
	if (isPlainSafe(text)) return text;
	// 有控制字符时单引号撑不住（Tab 之类），改用双引号转义。
	if (/[\u0000-\u001f\u007f]/.test(text)) return doubleQuote(text);
	return singleQuote(text);
}

function pad(indent) {
	return " ".repeat(indent);
}

function isPlainObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 多行字符串写成块标量：以换行结尾用 `|`，否则用 `|-`（不额外补换行）。 */
function formatBlock(text) {
	const keep = text.endsWith("\n");
	const body = keep ? text.slice(0, -1) : text;
	return { header: keep ? "|" : "|-", lines: body.split("\n") };
}

function emitMapping(obj, indent, lines) {
	for (const [key, value] of Object.entries(obj)) {
		const name = formatScalar(key);
		if (typeof value === "string" && value.includes("\n")) {
			const block = formatBlock(value);
			lines.push(pad(indent) + name + ": " + block.header);
			for (const line of block.lines) lines.push(line.length ? pad(indent + 2) + line : "");
			continue;
		}
		if (Array.isArray(value)) {
			if (!value.length) {
				lines.push(pad(indent) + name + ": []");
				continue;
			}
			lines.push(pad(indent) + name + ":");
			emitSequence(value, indent + 2, lines);
			continue;
		}
		if (isPlainObject(value)) {
			const keys = Object.keys(value);
			if (!keys.length) {
				lines.push(pad(indent) + name + ": {}");
				continue;
			}
			lines.push(pad(indent) + name + ":");
			emitMapping(value, indent + 2, lines);
			continue;
		}
		lines.push(pad(indent) + name + ": " + formatScalar(value));
	}
}

function emitSequence(arr, indent, lines) {
	for (const item of arr) {
		if (typeof item === "string" && item.includes("\n")) {
			const block = formatBlock(item);
			lines.push(pad(indent) + "- " + block.header);
			for (const line of block.lines) lines.push(line.length ? pad(indent + 2) + line : "");
			continue;
		}
		if (Array.isArray(item)) {
			if (!item.length) {
				lines.push(pad(indent) + "- []");
				continue;
			}
			lines.push(pad(indent) + "-");
			emitSequence(item, indent + 2, lines);
			continue;
		}
		if (isPlainObject(item)) {
			const keys = Object.keys(item);
			if (!keys.length) {
				lines.push(pad(indent) + "- {}");
				continue;
			}
			// 序列里的映射把第一个键写在 `- ` 后面，读起来更像手写的 YAML。
			const sub = [];
			emitMapping(item, indent + 2, sub);
			lines.push(pad(indent) + "- " + sub[0].slice(indent + 2));
			for (let index = 1; index < sub.length; index += 1) lines.push(sub[index]);
			continue;
		}
		lines.push(pad(indent) + "- " + formatScalar(item));
	}
}

/** 把 JS 值写成 YAML 文本（末尾带一个换行）。 */
export function stringify(value) {
	const lines = [];
	if (Array.isArray(value)) {
		if (!value.length) return "[]\n";
		emitSequence(value, 0, lines);
	} else if (isPlainObject(value)) {
		if (!Object.keys(value).length) return "{}\n";
		emitMapping(value, 0, lines);
	} else {
		return formatScalar(value) + "\n";
	}
	return lines.join("\n") + "\n";
}

/* ------------------------------------------------------------------- 读 */

function fail(message) {
	throw new Error("YAML 解析失败：" + message);
}

function indentOf(line) {
	let count = 0;
	while (count < line.length && line[count] === " ") count += 1;
	if (line[count] === "\t") fail("不允许用制表符缩进");
	return count;
}

function isBlank(line) {
	return line.trim() === "";
}

function isComment(line) {
	return line.trimStart().startsWith("#");
}

/** 去掉行尾注释：只认「空白 + #」且在引号外。 */
function stripComment(text) {
	let quote = "";
	for (let index = 0; index < text.length; index += 1) {
		const ch = text[index];
		if (quote) {
			if (ch === quote) {
				if (quote === "'" && text[index + 1] === "'") {
					index += 1;
					continue;
				}
				quote = "";
			} else if (quote === '"' && ch === "\\") {
				index += 1;
			}
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (ch === "#" && (index === 0 || /\s/.test(text[index - 1]))) return text.slice(0, index).trimEnd();
	}
	return text.trimEnd();
}

/** 解析一个标量文本。 */
function parseScalar(text) {
	const raw = text.trim();
	if (raw === "") return null;
	if (raw === "[]") return [];
	if (raw === "{}") return {};
	if (raw.startsWith('"')) {
		if (!raw.endsWith('"') || raw.length < 2) fail("双引号没有闭合：" + raw);
		try {
			return JSON.parse(raw);
		} catch (error) {
			fail("双引号字符串转义非法：" + raw);
		}
	}
	if (raw.startsWith("'")) {
		if (!raw.endsWith("'") || raw.length < 2) fail("单引号没有闭合：" + raw);
		return raw.slice(1, -1).replace(/''/g, "'");
	}
	if (raw === "null" || raw === "~") return null;
	if (raw === "true") return true;
	if (raw === "false") return false;
	if (NUMBER_LIKE.test(raw)) {
		const value = Number(raw);
		if (Number.isFinite(value)) return value;
	}
	if (BAD_START.test(raw)) fail("不支持的 YAML 语法：" + raw);
	return raw;
}

/** 从 `key: value` 里切出键与值；键可以是引号包裹的。 */
function splitPair(text) {
	const raw = text;
	if (raw.startsWith('"') || raw.startsWith("'")) {
		const quote = raw[0];
		let index = 1;
		while (index < raw.length) {
			if (raw[index] === quote) {
				if (quote === "'" && raw[index + 1] === "'") {
					index += 2;
					continue;
				}
				break;
			}
			if (quote === '"' && raw[index] === "\\") index += 1;
			index += 1;
		}
		if (index >= raw.length) fail("键的引号没有闭合：" + raw);
		const key = parseScalar(raw.slice(0, index + 1));
		const rest = raw.slice(index + 1).trimStart();
		if (!rest.startsWith(":")) fail("键后面缺少冒号：" + raw);
		return { key: String(key), rest: rest.slice(1).trim() };
	}
	const at = raw.indexOf(": ");
	if (at >= 0) return { key: raw.slice(0, at).trim(), rest: raw.slice(at + 2).trim() };
	if (raw.endsWith(":")) return { key: raw.slice(0, -1).trim(), rest: "" };
	fail("这一行既不是键值对也不是序列项：" + raw);
}

class Reader {
	constructor(text) {
		this.lines = String(text).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
		this.pos = 0;
	}

	/** 跳过空行、注释与文档头。 */
	skip() {
		while (this.pos < this.lines.length) {
			const line = this.lines[this.pos];
			if (isBlank(line) || isComment(line)) {
				this.pos += 1;
				continue;
			}
			if (line.trim() === "---" || line.trim() === "...") {
				this.pos += 1;
				continue;
			}
			return;
		}
	}

	peek() {
		this.skip();
		if (this.pos >= this.lines.length) return null;
		const line = this.lines[this.pos];
		return { indent: indentOf(line), text: line.slice(indentOf(line)) };
	}

	/** 块标量：`|` / `|-` / `|+` / `>` / `>-` / `>+`。调用方已经把 pos 推过头部那行。 */
	readBlock(header, parentIndent) {
		const folded = header[0] === ">";
		const chomp = header[1] || "";
		const collected = [];
		let contentIndent = -1;
		while (this.pos < this.lines.length) {
			const line = this.lines[this.pos];
			if (isBlank(line)) {
				collected.push("");
				this.pos += 1;
				continue;
			}
			const indent = indentOf(line);
			if (indent <= parentIndent) break;
			if (contentIndent < 0) contentIndent = indent;
			if (indent < contentIndent) break;
			// 注意：这里是「按内容缩进切掉前缀」，不是数组的 slice(start, end)。
			collected.push(line.slice(contentIndent));
			this.pos += 1;
		}
		// 去掉尾部多余空行（chomping 之后再补）。
		let trailing = 0;
		while (collected.length && collected[collected.length - 1] === "") {
			collected.pop();
			trailing += 1;
		}
		let body;
		if (folded) {
			const parts = [];
			for (const line of collected) {
				if (line === "") parts.push("\n");
				else if (parts.length && parts[parts.length - 1] !== "\n") parts.push(" " + line);
				else parts.push(line);
			}
			body = parts.join("");
		} else {
			body = collected.join("\n");
		}
		if (chomp === "-") return body;
		if (chomp === "+") return body + "\n".repeat(trailing + 1);
		return body + "\n";
	}

	readNode(indent) {
		const head = this.peek();
		if (!head || head.indent < indent) return null;
		if (head.text === "-" || head.text.startsWith("- ")) return this.readSequence(head.indent);
		return this.readMapping(head.indent);
	}

	readSequence(indent) {
		const out = [];
		for (;;) {
			const head = this.peek();
			if (!head || head.indent !== indent) break;
			if (head.text !== "-" && !head.text.startsWith("- ")) break;
			const rest = head.text === "-" ? "" : head.text.slice(2).trim();
			if (!rest) {
				this.pos += 1;
				const next = this.peek();
				out.push(next && next.indent > indent ? this.readNode(next.indent) : null);
				continue;
			}
			// `- key: value`：序列项是一个映射，从本行开始，后续键在更深的缩进。
			const inline = this.tryPair(rest);
			if (!inline) {
				this.pos += 1;
				out.push(this.parseInlineValue(rest, indent));
				continue;
			}
			const childIndent = indent + 2;
			const obj = {};
			this.pos += 1;
			this.assignPair(obj, inline, childIndent - 2, indent);
			for (;;) {
				const more = this.peek();
				if (!more || more.indent !== childIndent) break;
				if (more.text === "-" || more.text.startsWith("- ")) break;
				const pair = this.tryPair(more.text);
				if (!pair) break;
				this.pos += 1;
				this.assignPair(obj, pair, childIndent, indent);
			}
			out.push(obj);
		}
		return out;
	}

	readMapping(indent) {
		const out = {};
		for (;;) {
			const head = this.peek();
			if (!head || head.indent !== indent) break;
			if (head.text === "-" || head.text.startsWith("- ")) break;
			const pair = this.tryPair(head.text);
			if (!pair) fail("无法识别的行：" + head.text);
			this.pos += 1;
			this.assignPair(out, pair, indent, indent);
		}
		return out;
	}

	/** 试着把一行切成键值对；不是键值对返回 null。 */
	tryPair(text) {
		const trimmed = text.trim();
		if (!trimmed) return null;
		if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
			try {
				return splitPair(trimmed);
			} catch (error) {
				return null;
			}
		}
		if (trimmed.startsWith("[") || trimmed.startsWith("{")) return null;
		if (!trimmed.includes(":")) return null;
		const at = trimmed.indexOf(":");
		const after = trimmed.slice(at + 1);
		// `a:b` 是普通标量，`a: b` / `a:` 才是键值对。
		if (after !== "" && !after.startsWith(" ")) return null;
		try {
			return splitPair(trimmed);
		} catch (error) {
			return null;
		}
	}

	assignPair(target, pair, indent, parentIndent) {
		const value = pair.rest;
		if (value.startsWith("|") || value.startsWith(">")) {
			target[pair.key] = this.readBlock(value, indent);
			return;
		}
		if (value !== "") {
			target[pair.key] = this.parseInlineValue(value, parentIndent);
			return;
		}
		const next = this.peek();
		target[pair.key] = next && next.indent > parentIndent ? this.readNode(next.indent) : null;
	}

	parseInlineValue(text, parentIndent) {
		const cleaned = stripComment(text);
		if (cleaned.startsWith("|") || cleaned.startsWith(">")) return this.readBlock(cleaned, parentIndent);
		return parseScalar(cleaned);
	}
}

/** 把 YAML 文本读成 JS 值。 */
export function parse(text) {
	const source = String(text === undefined || text === null ? "" : text);
	if (!source.trim()) return null;
	const reader = new Reader(source);
	reader.skip();
	if (reader.pos >= reader.lines.length) return null;
	const first = reader.peek();
	const value = reader.readNode(first.indent);
	reader.skip();
	if (reader.pos < reader.lines.length) fail("文档末尾还有无法解析的内容：" + reader.lines[reader.pos]);
	return value;
}

export const __internals = { isPlainSafe: isPlainSafe, formatScalar: formatScalar, parseScalar: parseScalar, stripComment: stripComment };
