# NOTICE — 第三方代码与许可声明

本插件（`dsh-balance-inquiry`）的余额 / 用量查询功能基于 **cc-switch** 的余额查询功能实现。

## 被引用的项目

| 项目 | 仓库 | 许可 |
| --- | --- | --- |
| cc-switch（All-in-One Assistant for Claude Code, Codex & Gemini CLI） | <https://github.com/farion1231/cc-switch> | MIT |

引用时读取的源码快照：`cc-switch` 源码目录 `cc-switch/`，commit `a189980f35a4568f8cf3585747895c748b8cec6a`（作者：Jason Young）。

## 本插件复刻 / 翻译的部分

> 本插件查询功能基于 cc-switch 的余额查询功能实现。

以下逻辑是按 cc-switch 的对应实现逐条复刻（移植为 JavaScript，运行在 DSH 插件里）：

- 原生余额接口的地址识别与取值：`src-tauri/src/services/balance.rs`
  （DeepSeek、StepFun、SiliconFlow 国内 / 国际、OpenRouter、Novita）。
- 编程套餐（Token Plan / Coding Plan）用量查询：`src-tauri/src/services/coding_plan.rs`
  与 `src-tauri/src/commands/coding_plan.rs`
  （Kimi For Coding、智谱 GLM、智谱 GLM 团队版、MiniMax、ZenMux、火山方舟、OpenCode Go、Command Code），
  包括各家的请求地址、请求头、超时（15 秒）、响应解析、时间窗口归类（5 小时 / 周 / 月）与错误文案；
  火山方舟的 OpenAPI HMAC-SHA256 签名流程也按同一规范用纯 JavaScript 重新实现。
- 前端的预设表与自动识别顺序：`src/config/codingPlanProviders.ts`。
- 展示规则与瞬时失败处理：`src/components/quota/quotaRules.ts`、`src/lib/query/queries.ts`
  （余额为 0 才变红、按百分比的档位才有 < 10% 黄色预警、瞬时失败继续展示上次成功值、鉴权失败立即透出）。
- 自定义用量脚本引擎的字段校验与错误语义：`src-tauri/src/services/usage_script.rs`。

DSH 侧专有的部分（侧边栏条目、设置页、`localStorage` 配置、宿主进程代理路由
`/plugins/dsh-balance-inquiry/proxy`）由本插件自行实现，与 cc-switch 无关。

## 原作者的版权声明与许可声明

cc-switch 采用 MIT 许可，原样转载如下（来源：`cc-switch/LICENSE`）：

```
MIT License

Copyright (c) 2025 Jason Young

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
