#!/usr/bin/env node
/**
 * 发布脚本：校验 → 自测 → 打包预演 → 发布到 npm 官方源。
 *
 * 设计要点：
 *  1. 永远发到 https://registry.npmjs.org/，不受用户级 .npmrc（国内镜像）影响。
 *     用户 .npmrc 里配的是 registry.npmmirror.com，直接用 `npm publish` 会发错源。
 *  2. 发布前把仓库里的每个自测脚本跑一遍，任何一个失败就中止。
 *  3. 默认是预演（--dry-run 语义），必须显式加 --yes 才真正上传。
 *
 * 用法：
 *   node scripts/publish.mjs            # 预演：跑测试 + 打包 + 打印将要发布的版本
 *   node scripts/publish.mjs --yes      # 真正发布
 *   node scripts/publish.mjs --skip-tests --yes
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

/** 发布目标永远是 npm 官方源，不允许被环境变量或 .npmrc 改掉。 */
const OFFICIAL_REGISTRY = "https://registry.npmjs.org/";

const args = new Set(process.argv.slice(2));
const skipTests = args.has("--skip-tests");
const confirmed = args.has("--yes");

const step = (message) => console.log("\n\u001b[36m\u25b6 " + message + "\u001b[0m");
const ok = (message) => console.log("  \u001b[32m\u2713\u001b[0m " + message);
const fail = (message) => {
	console.error("\n\u001b[31m\u2717 " + message + "\u001b[0m");
	process.exit(1);
};

/**
 * Windows 上 npm 是 npm.cmd，必须经过 shell 才能启动；而 node 的可执行文件路径
 * （如 D:\Program Files\nodejs\node.exe）含空格，过 shell 会被拆断。
 * 所以只有 npm 走 shell，其余直连。
 */
const useShell = process.platform === "win32";

/** 同步执行一个命令并把输出实时透传到当前终端。 */
function run(command, commandArgs) {
	execFileSync(command, commandArgs, {
		cwd: root,
		stdio: "inherit",
		env: process.env,
		shell: useShell && command === "npm"
	});
}

/** 执行并捕获 stdout（用于读取版本号之类）。 */
function capture(command, commandArgs) {
	return execFileSync(command, commandArgs, {
		cwd: root,
		encoding: "utf8",
		shell: useShell && command === "npm"
	}).trim();
}

// ---------------------------------------------------------------- 1. 版本号
step("检查 package.json");
const pkgPath = join(root, "package.json");
if (!existsSync(pkgPath)) fail("找不到 package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const version = pkg.version;
if (!version) fail("package.json 缺少 version");
ok(pkg.name + "@" + version);

// 已发布的版本不允许重复发布，提前挡掉，省得等上传完才报错。
let published = [];
try {
	published = JSON.parse(capture("npm", ["view", pkg.name, "versions", "--json", "--registry=" + OFFICIAL_REGISTRY]) || "[]");
	if (!Array.isArray(published)) published = [published];
} catch (error) {
	console.warn("  ! 无法查询 npm 上的历史版本（可能没联网），跳过重复版本检查");
}
if (published.includes(version)) {
	fail("版本 " + version + " 已经发布过了，请先改 package.json 里的 version");
}
ok("npm 上还没有 " + version);

// ---------------------------------------------------------------- 2. 自测
if (skipTests) {
	console.warn("\n  ! 已按 --skip-tests 跳过自测");
} else {
	const tests = readdirSync(root)
		.filter((name) => /^(selftest|.*_test)\.mjs$/.test(name))
		.sort();
	if (!tests.length) fail("没有找到任何自测脚本，拒绝在没验证的情况下发布");
	step("运行自测（" + tests.length + " 个）");
	for (const test of tests) {
		process.stdout.write("  \u2026 " + test + " ");
		try {
			const output = capture(process.execPath, [join(root, test)]);
			const lastLine = output.split(/\r?\n/).filter(Boolean).pop() || "";
			ok(lastLine);
		} catch (error) {
			console.error("\n" + (error.stdout || "") + (error.stderr || ""));
			fail(test + " 失败，中止发布");
		}
	}
}

// ---------------------------------------------------------------- 3. 打包预演
step("打包预演（npm pack --dry-run）");
run("npm", ["pack", "--dry-run", "--registry=" + OFFICIAL_REGISTRY]);
ok("打包内容正常");

// ---------------------------------------------------------------- 4. 发布
step("发布到 " + OFFICIAL_REGISTRY);
if (!confirmed) {
	console.log("\n  \u001b[33m这是预演。确认无误后加 --yes 真正发布：\u001b[0m");
	console.log("  node scripts/publish.mjs --yes\n");
	process.exit(0);
}

// publishConfig 里已经锁死 registry 与 access，这里再显式传一次，双保险。
run("npm", [
	"publish",
	"--registry=" + OFFICIAL_REGISTRY,
	"--access=public",
	"--tag=latest"
]);
ok("已发布 " + pkg.name + "@" + version);
console.log("\n  https://www.npmjs.com/package/" + pkg.name + "/v/" + version + "\n");
