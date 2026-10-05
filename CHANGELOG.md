# 更新日志

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
