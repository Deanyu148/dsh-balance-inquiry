#!/usr/bin/env node
// 把 dsh-balance-inquiry 登记进某个 profile 的 dsh.profile.bundles。
//
//   node tools/register-profile-bundle.cjs [profileDir]
//
// 默认 profile：E:\.dsh\profiles\desktop（也可用环境变量 DSH_PROFILE_DIR 指定）
//
// 包管理器只负责把包装进 node_modules 并写 dependencies，而 DSH 加载哪些 bundle
// 看的是 profile package.json 里的 dsh.profile.bundles（启动时读取）。
const fs = require("node:fs");
const path = require("node:path");

const NAME = "dsh-balance-inquiry";

const profileDir = path.resolve(process.argv[2] || process.env.DSH_PROFILE_DIR || "E:\\.dsh\\profiles\\desktop");
const manifestPath = path.join(profileDir, "package.json");
const installed = path.join(profileDir, "node_modules", NAME);

if (!fs.existsSync(manifestPath)) {
	console.error("找不到 profile 清单：" + manifestPath);
	process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
manifest.dsh = manifest.dsh || {};
manifest.dsh.profile = manifest.dsh.profile || {};
const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : [];

if (bundles.includes(NAME)) {
	console.log("无需改动：" + NAME + " 已在 dsh.profile.bundles 里（第 " + (bundles.indexOf(NAME) + 1) + " 项）。");
} else {
	const anchor = bundles.indexOf("dsh-context");
	bundles.splice(anchor === -1 ? bundles.length : anchor + 1, 0, NAME);
	manifest.dsh.profile.bundles = bundles;
	const backup = path.join(profileDir, "package.json.bak-dsh-balance-inquiry");
	if (!fs.existsSync(backup)) fs.copyFileSync(manifestPath, backup);
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
	console.log("已登记：" + NAME + " → dsh.profile.bundles（第 " + (bundles.indexOf(NAME) + 1) + " / " + bundles.length + " 项，紧跟 dsh-context）");
	console.log("原清单已备份为：" + backup);
}

if (!fs.existsSync(installed)) {
	console.log("");
	console.log("⚠ 还没看到 " + installed);
	console.log("  请先在 profile 目录里用包管理器装上 " + NAME + "（或用本插件的 install 脚本）。");
}

console.log("");
console.log("下一步：完全退出并重新打开 DeepSeek Harness（profile 的 bundles 只在启动时读取）。");
