# 更新日志

[**English**](./CHANGELOG_en.md) ｜ 简体中文

## 0.4.5

- **修复「供应商ID」下拉缺失与文案未翻译**：
  - 下拉现在会列出 DSH 的**内置官方供应商**：`deepseek-official`（官方 API Key 登录）
    与 `deepseek-account`（账号登录）。它们注册时 `settingsPath` 为空、配置在自己的条目里而
    不是 `config.providers` 映射中，之前只扫设置文档所以完全看不到。
  - provider 列表改为「适配器目录（`llm.listConfigurableProviders()`）+ 设置文档 `providers` 映射」
    两路合并去重；目录抛错或旧运行时自动退回只扫设置文档，不影响原本能列出的自定义供应商。
  - 字段标题改为「供应商ID」，并补上中英文字典里缺失的 `form.dshProvider*` 三条文案
    （之前界面直接把原始键名显示出来）。
  - 自测：新增官方路由可见性、两路去重、目录不可用/抛错退化、下拉渲染与文案回归断言。

## 0.4.4

- **安全绑定与自动切换供应商**：
  - 取消在宿主端嗅探/获取 `baseURL` 等敏感网络信息的行为。
  - 宿主端新增受约束的只读路由 `GET /plugins/dsh-balance-inquiry/providers`，安全返回已配置的 provider id 与显示名称列表。
  - 套餐支持绑定 DSH `cordis.patch.yml` 中已有的 provider id（`dshProviderId`）。
  - 在 DSH 中切换模型/供应商时，左下角侧边栏按钮自动感知并切换为对应供应商套餐的余额；未匹配或未绑定时回退展示所有套餐中最紧急的一项。

## 0.4.1

- 新增英文文档 [`README_en.md`](./README_en.md) 与 [`CHANGELOG_en.md`](./CHANGELOG_en.md)，
  中文版顶部加「English」语言切换链接。
- npm 包里一并带上这两个英文文件。

## 0.4.0

- **多套餐**：一个套餐 = 一条配置（厂商 / 计费类型 / 令牌 / 接口地址 / 官网地址）。
  「添加套餐」弹窗先选计费类型（按量计费 API Key 还是 Token Plan / Coding Plan）再选厂商；
  已添加的套餐在一级设置页里排成一列长条按钮（套餐名称 + 剩余额度），点进去是二级编辑页。
- **取消自动识别**：删掉 `auto` 查询方式与地址嗅探；厂商由套餐显式指定，地址不再参与决策。
- **余额看板**：侧边栏按钮**左键**打开看板（`shell.overlay`），每个套餐一张圆角长方形卡片，
  显示套餐名称、剩余额度、上次查询时间；**左键**点卡片打开该套餐的官网地址；
  看板里也可以直接添加套餐、立即查询。按 Esc 或点遮罩关闭。
- **按积分 / credits 计的套餐不再显示 quota 换算比例**：只有 New API 与自定义脚本才显示
  「额度换算比例 / 货币单位」。
- **当前供应商**：宿主半边新增只读路由 `GET /plugins/dsh-balance-inquiry/whoami`，
  读 `agentDefaultModel` 与当前供应商的 `baseURL`（不含任何密钥）；「添加套餐」时置顶一个
  「使用当前正在用的供应商」的一键添加项。
- 存储改为三份：`dsh-balance-inquiry:accounts`（套餐）、`:settings`（通用设置）、
  `:results`（每个套餐的上次读数）；旧的单套餐配置在首次读取时转成一条套餐。
- 自测：客户端 234 项断言、宿主半边 27 项断言、装机校验 22 项逐文件比对。

## 0.3.3

- 以当前实现作为基线，清掉历史包袱：删除旧的配置迁移（秒级 `refreshSeconds` → 分钟级
  `autoQueryInterval`）、旧存储键（`dsh-quota:*`）迁移、旧出厂地址清理，以及安装脚本里
  针对旧包名的清理逻辑。
- 精简注释：只保留功能性说明，删除出处标注与沿革说明；`NOTICE.md` 只说明许可证与版权，
  `LICENSE` 只保留 MIT 正文。
- README 删掉「重装 / 恢复」「致谢与许可」等说明性小节，去掉迁移与改名相关内容。
- 自测：客户端 219 项断言、宿主代理 22 项断言、装机校验逐文件比对。

## 0.3.2

- 出厂不再预设任何站点：`baseUrl` / `websiteUrl` 默认为空，没填地址就不发请求；
  设置页状态区分「尚未填写接口地址」与「尚未填写访问令牌」。
- 地址与访问令牌都为空时，侧边栏按钮只刷新、不跳转。

## 0.3.1

- 安装说明改用官方命令 `dsh plugin --profile desktop add dsh-balance-inquiry`；
  `files` 增加 `docs/*.png` 与 `CHANGELOG.md`。

## 0.3.0

- 新增 8 家编程套餐（Token Plan / Coding Plan）的用量查询，时间窗口统一归一为 5 小时 / 周 / 月。
- 插件更名为 `dsh-balance-inquiry`，更换插件图标与设置页名称。
- 新增宿主半边代理路由：浏览器直连被 CORS 拦住时改由宿主进程发请求。

## 0.2.0

- 支持 New API、DeepSeek、StepFun、SiliconFlow、OpenRouter、Novita 六类原生余额接口，
  以及自定义用量脚本。
- keep-last-good：瞬时失败 10 分钟内继续展示上次成功的余额。
- 多套餐 / 多币种、侧边栏 tooltip、官网地址可配置、自动刷新间隔与请求超时。

## 0.1.0

- 首个版本：侧边栏底部显示「剩余额度：XXX ￥」，点击打开官网。
