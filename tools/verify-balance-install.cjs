#!/usr/bin/env node
/**
 * 校验 dsh-balance-inquiry 是否已经**正确装进 profile**（不需要 DSH 在运行）。
 *
 * 检查项：
 *   1. profile 清单里有 dependencies.dsh-balance-inquiry 与 dsh.profile.bundles 里的 dsh-balance-inquiry；
 *   2. 装好的包能按包名解析（宿主半边可以 import，客户端 bundle 能 resolve 到）；
 *   3. 客户端 bundle 只 require 冻结基线里的模块（react）；
 *   4. 源目录与装好的目录逐文件 SHA256 一致（没有装了旧版本）。
 *
 * 用法：node tools/verify-balance-install.cjs
 */
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");

const SOURCE = path.resolve(__dirname, "..");
const PROFILE = process.env.DSH_PROFILE_DIR || "E:\\.dsh\\profiles\\desktop";
const INSTALLED = path.join(PROFILE, "node_modules", "dsh-balance-inquiry");
const FILES = [
	"package.json",
	"cordis.patch.yml",
	"icon.svg",
	"lib/index.js",
	"lib/client.js",
	"lib/index.d.ts",
	"README.md",
	"NOTICE.md",
	"LICENSE",
	"locale/zh.json",
	"locale/en.json"
];

let total = 0;
let failures = 0;

function check(name, condition, detail) {
	total += 1;
	if (!condition) {
		failures += 1;
		console.log("  x " + name + (detail === undefined ? "" : "  -> " + String(detail)));
	} else {
		console.log("  v " + name + (detail === undefined ? "" : "  -> " + String(detail)));
	}
}

function sha256(file) {
	return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

async function main() {
	console.log("dsh-balance-inquiry 安装校验（" + process.version + "）");
	console.log("  profile : " + PROFILE);
	console.log("  源目录  : " + SOURCE);

	const manifestPath = path.join(PROFILE, "package.json");
	const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	const declared = manifest.dependencies && manifest.dependencies["dsh-balance-inquiry"];
	const bundles = (manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles) || [];

	console.log("\n1. profile 清单");
	check("dependencies.dsh-balance-inquiry 已声明", Boolean(declared), declared);
	check("dsh.profile.bundles 含 dsh-balance-inquiry", bundles.includes("dsh-balance-inquiry"), "index " + bundles.indexOf("dsh-balance-inquiry") + "/" + bundles.length);
	check("bundles 里紧跟 dsh-context（保持顺序）", bundles.indexOf("dsh-balance-inquiry") === bundles.indexOf("dsh-context") + 1);
	// 改名前的残留（dsh-quota）必须清干净，否则 DSH 启动时会去加载一个不存在的插件。
	check("旧包名 dsh-quota 已从 dependencies 移除", !(manifest.dependencies && "dsh-quota" in manifest.dependencies));
	check("旧包名 dsh-quota 已从 bundles 移除", !bundles.includes("dsh-quota"));
	check("旧包目录 node_modules/dsh-quota 已删除", !fs.existsSync(path.join(PROFILE, "node_modules", "dsh-quota")));

	console.log("\n2. 包能按名字解析");
	const require_ = createRequire(path.join(PROFILE, "package.json"));
	let clientPath = "";
	try {
		clientPath = require_.resolve("dsh-balance-inquiry/client");
		check("resolve('dsh-balance-inquiry/client')", true, clientPath);
	} catch (error) {
		check("resolve('dsh-balance-inquiry/client')", false, String(error && error.message));
	}
	const hostHalf = await import(pathToFileURL(path.join(INSTALLED, "lib", "index.js")).href);
	check("宿主半边 name = dsh-balance-inquiry", hostHalf.name === "dsh-balance-inquiry", hostHalf.name);
	check("宿主半边 inject = ['webServer']", Array.isArray(hostHalf.inject) && hostHalf.inject.join(",") === "webServer", JSON.stringify(hostHalf.inject));
	check("宿主半边 apply 是函数", typeof hostHalf.apply === "function");

	console.log("\n3. 客户端 bundle 的依赖面");
	if (clientPath) {
		const source = fs.readFileSync(clientPath, "utf8");
		const ids = [...source.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1]);
		const unique = [...new Set(ids)];
		check("只 require 冻结基线模块（react）", unique.length === 1 && unique[0] === "react", JSON.stringify(unique));
		check("以 __ModuleLoader__.load 包裹", source.includes("window.__ModuleLoader__.load("), source.slice(0, 60));
		check("客户端含宿主代理调用", source.includes("/plugins/dsh-balance-inquiry/proxy") && source.includes(`"POST"`), source.includes("/plugins/dsh-balance-inquiry/proxy"));
		check("宿主半边含代理路由", hostHalf.apply.toString().includes("webServer") || fs.readFileSync(path.join(INSTALLED, "lib", "index.js"), "utf8").includes("dsh-balance-inquiry/proxy"));
	}

	console.log("\n4. 文件一致性（源 vs 已安装）");
	for (const file of FILES) {
		const a = path.join(SOURCE, file);
		const b = path.join(INSTALLED, file);
		if (!fs.existsSync(a) || !fs.existsSync(b)) {
			check(file, false, "缺文件");
			continue;
		}
		const same = sha256(a) === sha256(b);
		check(file, same, (same ? "SAME" : "DIFF") + " · " + fs.statSync(b).size + " B");
	}

	console.log("\n" + "=".repeat(64));
	console.log((failures === 0 ? "全部通过" : "存在失败") + "：" + (total - failures) + "/" + total + " 项断言通过");
	console.log("（profile 的 dependencies / bundles 只在启动时读取：改完请完全退出并重新打开 DSH）");
	return failures === 0 ? 0 : 1;
}

main()
	.then((code) => process.exit(code))
	.catch((error) => {
		console.log("校验脚本自身出错：" + (error && error.message ? error.message : String(error)));
		if (error && error.stack) console.log(error.stack);
		process.exit(2);
	});
