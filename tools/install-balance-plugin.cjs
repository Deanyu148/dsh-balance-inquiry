#!/usr/bin/env node
// 把 dsh-balance-inquiry 插件安装（或重新安装）到某个 DSH profile。
//
//   node tools/install-balance-plugin.cjs [profileDir]
//
// 默认 profile：E:\.dsh\profiles\desktop（也可用环境变量 DSH_PROFILE_DIR 指定）
//
// 幂等：重复执行只覆盖包目录、并补齐 profile 清单里缺的条目。
const fs = require("node:fs");
const path = require("node:path");

/** GitHub 仓库（npm 上取不到时用的备用依赖规格）。 */
const REPO = "Deanyu148/dsh-balance-inquiry";

const src = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(src, "package.json"), "utf8"));
const name = pkg.name;
/** 默认写 npm 上的版本规格（pnpm/npm 能直接解析）。 */
const NPM_SPEC = "^" + pkg.version;
/** 包还没发到 npm 时改用仓库规格（pnpm 会走 git，需要能访问 GitHub）。 */
const GIT_SPEC = "github:" + REPO + "#v" + pkg.version;
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

// 2) 补齐 profile 清单
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
manifest.dependencies = manifest.dependencies || {};
manifest.dsh = manifest.dsh || {};
manifest.dsh.profile = manifest.dsh.profile || {};
manifest.dsh.profile.bundles = manifest.dsh.profile.bundles || [];

const added = [];
// 依赖规格要写成包管理器能解析的形式（等价于 pnpm add dsh-balance-inquiry），
// 裸版本号在包发到 npm 之前会让以后任何一次 `pnpm install` / 插件市场操作都 404。
// 清单里已经是 file:/link:/workspace: 这类本地指向时原样保留，不覆盖用户的写法。
const currentDep = manifest.dependencies[name];
const isLocalDep = typeof currentDep === "string" && /^(file:|link:|workspace:|portal:)/.test(currentDep);
const wantedDep = isLocalDep ? currentDep : NPM_SPEC;
if (currentDep !== wantedDep) {
	manifest.dependencies[name] = wantedDep;
	added.push("dependencies." + name + " = " + wantedDep + (currentDep === undefined ? "" : "（原 " + currentDep + "）"));
}
// bundles 里的位置固定成「紧跟 dsh-context」（不影响其它插件的相对顺序）；被 dshmarket/pnpm
// 挪到别处时自愈，保证侧边栏那一行的加载顺序稳定。
{
	const bundles = manifest.dsh.profile.bundles;
	const rest = bundles.filter((item) => item !== name);
	const anchor = rest.indexOf("dsh-context");
	const next = rest.slice();
	next.splice(anchor === -1 ? next.length : anchor + 1, 0, name);
	if (JSON.stringify(next) !== JSON.stringify(bundles)) {
		manifest.dsh.profile.bundles = next;
		added.push(bundles.includes(name) ? "dsh.profile.bundles 位置归位（紧跟 dsh-context）" : "dsh.profile.bundles += " + name);
	}
}
if (added.length > 0) {
	const backup = path.join(profileDir, "package.json.bak-dsh-balance-inquiry");
	if (!fs.existsSync(backup)) fs.copyFileSync(manifestPath, backup);
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}

// 3) 自检：清单、包体、宿主半边
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
console.log("想改用 pnpm / npm 管理也可以：在 profile 目录里 pnpm add " + name + "（" + NPM_SPEC + "），");
console.log("然后 node tools/register-profile-bundle.cjs " + profileDir + " 登记 bundles 条目（pnpm 不会自动登记）。");
