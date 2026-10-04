# 更新日志

## 0.3.0

- 新增 **8 家编程套餐（Token Plan / Coding Plan）**的用量查询：Kimi For Coding、智谱 GLM、
  智谱 GLM 团队版、MiniMax、ZenMux、火山方舟（Agent / Coding Plan）、OpenCode Go、Command Code；
  时间窗口统一归一为 5 小时 / 周 / 月，按百分比显示，剩余不足 10% 时变黄。
- 新增 `NOTICE.md`：声明查询功能基于 cc-switch 的余额查询功能实现，附原作者版权与 MIT 许可全文。
- 插件从 `dsh-quota` 改名为 `dsh-balance-inquiry`（设置项名称改为「余额查询」），
  旧存储键（`dsh-quota:config` / `dsh-quota:last-reading`）会在首次读取时自动迁移。
- 侧边栏 tooltip 增加每个时间窗口的重置时间；设置页在选「智谱 GLM 团队版」时显示组织 / 项目 ID，
  选「火山方舟」时显示 AccessKey ID / SecretAccessKey。
- 安装方式补充：新增 `tools/register-profile-bundle.cjs`（用 pnpm 装完后把包名登记进
  `dsh.profile.bundles`，pnpm 自己不会登记），README 增加「用 pnpm 安装」章节
  （`pnpm add github:Deanyu148/dsh-balance-inquiry#v0.3.0`）；profile 里的依赖规格由裸版本号
  改为 GitHub 规格，否则在插件发布到 npm 之前，任何一次 `pnpm install` 都会 404。

## 0.2.1

- 修复跨域：宿主半边新增受限代理路由 `/plugins/dsh-balance-inquiry/proxy`，
  请求优先由 **DSH 宿主进程**（Node，不受浏览器同源策略约束）发出，
  宿主通道不可用时自动回落浏览器直连，并在设置页显示当前通道。
- 设置页「保存」按钮改为浅色底 + 深色字，避免白底白字。

## 0.2.0

- 复刻 cc-switch 的余额查询：原生余额接口（DeepSeek、StepFun、SiliconFlow、OpenRouter、Novita）、
  New API 的 `/api/user/self`、自定义用量脚本（占位符 + 多套餐提取）。
- keep-last-good：瞬时失败 10 分钟内继续展示上次成功的余额；确定性失败立即清掉旧值。
- 多套餐 / 多币种、侧边栏 tooltip、官网地址可配置、自动刷新间隔与超时。

## 0.1.0

- 首个版本：侧边栏底部显示「剩余额度：XXX ￥」，点击打开官网。
