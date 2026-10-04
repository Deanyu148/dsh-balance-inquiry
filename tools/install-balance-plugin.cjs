#!/usr/bin/env node
// 把 dsh-balance-inquiry 插件安装（或重新安装）到某个 DSH profile。
//
//   node tools/install-balance-plugin.cjs [profileDir]
//
// 默认 profile：E:\.dsh\profiles\desktop（也可用环境变量 DSH_PROFILE_DIR 指定）
//
// 幂等：重复执行只覆盖包目录、并补齐 profile 清单里缺的条目。
// 另外会清掉改名前的 dsh-quota 残留（依赖声明、bundles 条目、node_modules 目录），
// 避免 DSH 启动时去加载一个已经不存在的插件。
const fs = require("node:fs");
const path = require("node:path");

/** 改名前的包名（安装脚本会清理它）。 */
const LEGACY_NAME = "dsh-quota";

const src = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(src, "package.json"), "utf8"));
const name = pkg.name;
const profileDir = path.resolve(process.argv[2] || process.env.DSH_PROFILE_DIR || "E:\\.dsh\\profiles\\desktop");
const dst = path.join(profileDir, "node_modules", name);
const manifestPath = path.join(profileDir, "package.json");

for (const required of [src, manifestPath]) {
	if (!fs.existsSync(required)) {
		console.error("找不到：" + required);
		process.exit(1);
	}
}

/** 把 package.json 的 files 条目展开成相对路径（支持 `dir/*.ext`）。 */
function expand(entry) {
	const normalized = entry.replace(/\\/g, "/");
	if (!normalized.includes("*")) return [normalized];
	const dir = path.posix.dirname(normalized);
	const pattern = new RegExp(
		"^" + path.posix.basename(normalized).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"
	);
	const from = dir === "." ? src : path.join(src, dir);
	return fs
		.readdirSync(from)
		.filter((file) => pattern.test(file))
		.map((file) => (dir === "." ? file : dir + "/" + file));
}

// 1) 复制包目录（只复制 package.json + files 里列出的内容，不带 .git / tools）
const copied = [];
fs.rmSync(dst, { recursive: true, force: true });
fs.mkdirSync(dst, { recursive: true });
for (const entry of ["package.json"].concat(pkg.files || [])) {
	for (const rel of expand(entry)) {
		const from = path.join(src, rel);
		if (!fs.existsSync(from)) {
			console.error("files 里列出的内容不存在：" + rel);
			process.exit(1);
		}
		const to = path.join(dst, rel);
		fs.mkdirSync(path.dirname(to), { recursive: true });
		fs.copyFileSync(from, to);
		copied.push(rel);
	}
}

// 2) 补齐 profile 清单，并清掉改名前的残留条目
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
manifest.dependencies = manifest.dependencies || {};
manifest.dsh = manifest.dsh || {};
manifest.dsh.profile = manifest.dsh.profile || {};
manifest.dsh.profile.bundles = manifest.dsh.profile.bundles || [];

const added = [];
if (manifest.dependencies[LEGACY_NAME] !== undefined) {
	delete manifest.dependencies[LEGACY_NAME];
	added.push("dependencies -= " + LEGACY_NAME);
}
if (manifest.dsh.profile.bundles.includes(LEGACY_NAME)) {
	manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((item) => item !== LEGACY_NAME);
	added.push("bundles -= " + LEGACY_NAME);
}
if (manifest.dependencies[name] !== pkg.version) {
	manifest.dependencies[name] = pkg.version;
	added.push("dependencies." + name + " = " + pkg.version);
}
if (!manifest.dsh.profile.bundles.includes(name)) {
	const anchor = manifest.dsh.profile.bundles.indexOf("dsh-context");
	manifest.dsh.profile.bundles.splice(anchor === -1 ? manifest.dsh.profile.bundles.length : anchor + 1, 0, name);
	added.push("dsh.profile.bundles += " + name);
}
if (added.length > 0) {
	const backup = path.join(profileDir, "package.json.bak-dsh-balance-inquiry");
	if (!fs.existsSync(backup)) fs.copyFileSync(manifestPath, backup);
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}

// 3) 清掉改名前的包目录
const legacyDir = path.join(profileDir, "node_modules", LEGACY_NAME);
if (fs.existsSync(legacyDir)) {
	fs.rmSync(legacyDir, { recursive: true, force: true });
	added.push("删除 node_modules/" + LEGACY_NAME);
}

// 4) 自检：清单、包体、宿主半边
JSON.parse(fs.readFileSync(manifestPath, "utf8"));
for (const file of ["package.json", "cordis.patch.yml", "lib/index.js", "lib/client.js"]) {
	if (!fs.existsSync(path.join(dst, file))) {
		console.error("安装不完整，缺少 " + file);
		process.exit(1);
	}
}

console.log("包名     : " + name + " " + pkg.version);
console.log("源目录   : " + src);
console.log("已安装到 : " + dst);
console.log("复制文件 : " + copied.length + " 个（" + copied.join(", ") + "）");
console.log("清单改动 : " + (added.length ? added.join("；") : "无需改动（已是最新）"));
console.log("bundles  : " + manifest.dsh.profile.bundles.join(", "));
console.log("");
console.log("下一步：完全退出并重新打开 DeepSeek Harness（profile 的 bundles 只在启动时读取）。");
