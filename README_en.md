# dsh-balance-inquiry

English ｜ [简体中文](./README.md)

Published on npm: [`dsh-balance-inquiry`](https://www.npmjs.com/package/dsh-balance-inquiry)
(`npm i dsh-balance-inquiry` / `pnpm add dsh-balance-inquiry`).

Adds one row at the bottom of the DSH left sidebar, **above** "Context Insights":

```
💰 剩余额度：12.34 ￥
```

![Main view](docs/screenshot-1.png)
![Lookup](docs/screenshot-2.png)
![Settings](docs/screenshot-3.png)

- **Multiple plans**: one plan = one configuration. The sidebar shows the most urgent plan
  across all of them. **Left click the row to open the balance board**, where every plan is a
  rounded rectangle card (plan name / remaining balance / last query time).
- On the board: **left click a card to open that plan's provider site**. There are also
  "Add plan" and "Refresh now" buttons. Press Esc or click the backdrop to close.
  To view or edit a plan, go to Settings → Balance Inquiry and click its bar.
- The settings page has two levels: level 1 is "Add plan" + a list of bars for the plans you
  added + global settings. Clicking "Add plan" opens a dialog that first asks
  **Pay-as-you-go (API Key)** or **Token Plan / Coding Plan**, then the provider.
  Clicking a bar opens the level-2 edit page (rename the plan, change the provider, token,
  endpoint, website, or delete the plan).
- Supports six **native balance endpoints**: New API (one-api / new-api family), DeepSeek,
  StepFun, SiliconFlow (China / international), OpenRouter, Novita AI — plus a
  **custom usage script**
  (`({ request: {…}, extractor: function (response) {…} })`, with
  `{{baseUrl}}` / `{{apiKey}}` / `{{accessToken}}` / `{{userId}}` placeholders).
- Supports usage queries for **8 coding plans (Token Plan / Coding Plan)**: Kimi For Coding,
  Zhipu GLM, Zhipu GLM Team, MiniMax, ZenMux, Volcengine Ark (Agent / Coding Plan),
  OpenCode Go, Command Code. Each time window (5-hour / weekly / monthly) shows a
  **used percentage and remaining percentage**; below 10% remaining turns yellow.
- New API defaults to `GET {baseUrl}/api/user/self`, and the displayed value is
  `data.quota ÷ conversion rate` (default 500000, i.e. 1 ￥ = 500000 quota).
  **Plans billed in credits / points do not show the conversion rate.**
- **There is no "auto detect"**: the provider is specified explicitly per plan, and the
  endpoint no longer takes part in that decision.
- **Auto Switch on Provider Change**: Plans can bind to an existing provider ID configured in DSH `cordis.patch.yml`.
  When switching models/providers in DSH, the bottom-left entry automatically displays the balance of the linked plan; falls back to the most critical plan when unmatched.
- Multiple plans and multiple currencies are supported: the sidebar shows the lowest (most critical) or active plan's balance, and the hover tooltip lists every plan
  (including each plan's window names and reset times).
- **keep-last-good**: on a transient failure (network error / timeout / 5xx / 429) the last
  successful balance keeps showing for 10 minutes, marked "Last success: …". Deterministic
  failures such as authentication errors surface immediately and clear the stale value so you
  never see an outdated balance.
- The balance only turns red at **exactly 0**; only percentage-based windows use the
  "below 10% remaining" yellow warning.
- Requests are sent by the **DSH host process** by default, free of browser CORS limits; when
  the host route is unavailable the plugin falls back to a direct browser request.
- Secure boundaries: removed host sniffing of `baseURL` and external network addresses; only uses safe provider ID references.

## Install

```powershell
dsh plugin --profile desktop add dsh-balance-inquiry
```


> The profile dependency list and bundles are read **at startup**, so restart the DSH desktop
> app after installing (or restart `dsh web` for the web version). The row then appears at the
> bottom of the sidebar.

## Configuration

Open **Settings → Balance Inquiry** (level 1):

> The plugin **presets no sites at all**: both the endpoint and the website are empty, and it
> never queries any third-party service on its own. On first use, click "Add plan" and fill in
> your own values. When both URLs are empty, board cards simply do not navigate.

| Field | Description |
| --- | --- |
| Plan name | Shown on board cards and in the sidebar tooltip; falls back to the provider name |
| Billing type | `Pay-as-you-go (API Key)` or `Token Plan / Coding Plan`. Decides the available providers and the fields shown |
| Provider | Pay-as-you-go: New API / One API, DeepSeek, StepFun, SiliconFlow (China / international), OpenRouter, Novita AI, Custom script. Coding plans: Kimi For Coding, Zhipu GLM, Zhipu GLM Team, MiniMax, ZenMux, Volcengine Ark, OpenCode Go, Command Code |
| Endpoint | For example `https://api.example.com` — no trailing `/`. Native providers use their official endpoint and hide this field |
| Usage endpoint | For coding plans. Required by ZenMux; Volcengine Ark uses it to infer the region (e.g. `https://ark.cn-beijing.volces.com/api/plan/v3`) |
| Access token / console token | New API uses the console's "system access token" (**not** an `sk-…` API key), sent as `Authorization: Bearer …`. Native providers and coding plans use that platform's token |
| User ID | Sent as the `New-Api-User` header; required by some sites |
| Organization ID / Project ID | Appear for "Zhipu GLM Team", sent as the `bigmodel-organization` / `bigmodel-project` headers |
| AccessKey ID / SecretAccessKey | Appear for "Volcengine Ark", used for OpenAPI signing (these are not inference API keys) |
| Website | Opened by left-clicking a board card; when empty, the endpoint is used instead |
| Conversion rate / currency unit | **Only shown for New API and custom scripts**. Plans billed in credits / points never show it |
| Custom script | Appears for "Custom script", next to "Fill New API template" / "Fill generic template" buttons |
| Auto refresh interval | **Minutes**, 0 = never query automatically; default 5 (global setting) |
| Request timeout | Seconds, 2–30, default 10 (global setting) |

Configuration lives in the renderer's `localStorage`: the plan list in
`dsh-balance-inquiry:accounts`, global settings in `dsh-balance-inquiry:settings`, and each
plan's latest reading in `dsh-balance-inquiry:results`. After a restart the board therefore
shows the previous balances immediately without waiting for the first request.

## Provider endpoints

| Billing type / provider | Endpoint | Value |
| --- | --- | --- |
| Pay-as-you-go · New API | `GET {baseUrl}/api/user/self` | `data.quota ÷ conversion rate` |
| DeepSeek | `GET https://api.deepseek.com/user/balance` | `balance_infos[].total_balance` (one entry per currency) |
| StepFun | `GET https://api.stepfun.com/v1/accounts` | `balance` (CNY) |
| SiliconFlow | `GET https://api.siliconflow.{cn,com}/v1/user/info` | `data.totalBalance` |
| OpenRouter | `GET https://openrouter.ai/api/v1/credits` | `total_credits - total_usage` |
| Novita AI | `GET https://api.novita.ai/v3/user/balance` | `availableBalance ÷ 10000` (USD) |

Response parsing, error text (`Network error: …` / `Authentication failed (HTTP 401)` /
`Failed to parse response: …`), the script engine's field validation, and the 200-character
error body preview are all implemented by the plugin itself. You can see the exact reason for
every query in **Settings → Balance Inquiry**.

## Coding plans (Token Plan / Coding Plan)

In the "Add plan" dialog choose `Token Plan / Coding Plan`, then pick the provider (there is no
auto detection any more). A coding plan has no concept of a "balance", so what you see is the
**usage percentage** of each time window: the board card takes the most urgent one (most used /
least remaining), and the tooltip and edit page list every window.

| Provider | Endpoint | What to fill in |
| --- | --- | --- |
| Kimi For Coding | `GET https://api.kimi.com/coding/v1/usages` | Access token |
| Zhipu GLM | `GET {open.bigmodel.cn \| api.z.ai}/api/monitor/usage/quota/limit` | Access token (the endpoint decides China vs. international) |
| Zhipu GLM Team | `GET https://open.bigmodel.cn/api/monitor/usage/quota/limit?type=2` | Access token + organization ID + project ID (not auto-detected, choose it manually) |
| MiniMax | `GET {api.minimaxi.com \| api.minimax.io}/v1/api/openplatform/coding_plan/remains` | Access token (the endpoint decides China vs. international) |
| ZenMux | `GET {endpoint}/api/usage` | Access token + endpoint (or ZenMux's usage-script URL) |
| Volcengine Ark (Agent / Coding Plan) | `POST https://open.volcengineapi.com/?Action=GetAFPUsage\|GetCodingPlanUsage&Version=2024-01-01` | AccessKey ID + SecretAccessKey (OpenAPI signing; the endpoint infers the region) |
| OpenCode Go | `GET https://opencode.ai/zen/go/v1/usage` | Access token |
| Command Code | `GET https://api.commandcode.ai/alpha/...` (4 sequential calls: whoami → credits → subscriptions → usage/summary) | Access token |

- Time windows are normalized to **5-hour / weekly / monthly**: Kimi's `limits[]` (5-hour) and
  `usage` (weekly), Zhipu's `TOKENS_LIMIT` / `CREDIT_LIMIT` (`unit` 3 = 5-hour, 6 = weekly),
  MiniMax's `model_remains[]` (the `general` model's interval / week), ZenMux's `quota_5_hour` /
  `quota_7_day`, Volcengine's `AFPFiveHour` / `AFPWeekly` / `AFPMonthly` + `QuotaUsage[]`,
  OpenCode Go's `rolling` / `weekly` / `monthly`, and Command Code's `windowLimits` plus its
  monthly pool.
- Volcengine Ark queries **Agent Plan** first and falls back to **Coding Plan** when there is no
  active subscription; only when neither exists does it report "no active subscription found".
- Every coding-plan request uses a 15-second timeout. Authentication failures (401 / 403 /
  signing errors) mark the token as invalid and include the reason returned by the server.
- When a plan also returns a USD amount (ZenMux, Command Code), that amount is displayed instead
  of a percentage.

## Custom usage script

With the "Custom script" provider you can paste a script that evaluates to an object, to adapt to
any site:

```js
({
  request: {
    url: "{{baseUrl}}/api/user/self",
    method: "GET",
    headers: { "Authorization": "Bearer {{accessToken}}", "New-Api-User": "{{userId}}" }
  },
  extractor: function (response) {
    return {
      planName: response.data.group || "default",
      remaining: response.data.quota / {{rate}},
      used: response.data.used_quota / {{rate}},
      total: (response.data.quota + response.data.used_quota) / {{rate}},
      unit: "CNY"
    };
  }
})
```

- Placeholders: `{{baseUrl}}`, `{{apiKey}}` / `{{accessToken}}` (the current token),
  `{{userId}}`, `{{rate}}` (the conversion rate).
- `extractor` may return **one item or an array of items** (multiple plans / currencies) with the
  fields `{ planName, remaining, used, total, unit, isValid, invalidMessage }`.
- HTTPS only (except local `http://localhost`). Script syntax errors, a throwing `extractor`,
  returning a primitive such as a number — all report a reason on the settings page; when
  `extractor` returns `isValid: false` the button shows "invalid" rather than a hard error.
- The two adjacent buttons fill in the New API template / generic template in one click.

## Why a query can fail

The plugin sends requests through the **host process** by default (Node, not bound by the
browser's same-origin policy), but these situations can still occur:

| Symptom | Cause | What to do |
| --- | --- | --- |
| `网络错误 Network error: 无法连接 <host>` | DNS failure / no connectivity; or the request went through the direct browser path and the target site did not return `Access-Control-Allow-Origin` | Fully quit and reopen DSH so the host route takes effect; confirm the address itself works |
| `请求超时 Request failed: timeout after Ns` | The target site is slow or unreachable | Raise "Request timeout" (2–30 seconds) |
| `Authentication failed (HTTP 401)` / `无权进行此操作，access token 无效` | Wrong token: New API wants the console's "system access token", not the API key used for chat; some sites also need "User ID" | Copy the token again, add the user ID, click "Refresh now" |
| `Failed to parse response: 缺少字段 …` | The address does not point at that provider's balance endpoint, or the site's fields differ | Switch the provider to "Custom script" and write your own extraction rules |
| The old balance marked "Last success" keeps showing | The latest query failed transiently and the last successful value is kept for 10 minutes | Check the reason on the settings status line, or click "Refresh now" to retry |
| The settings page says "Query channel: direct browser" at the bottom | The host route is not in effect (usually DSH was not restarted, or the webserver is disabled) | Fully quit and reopen DSH |

How the host channel works:

```
renderer                                      host process (Node, no CORS limits)
  POST /plugins/dsh-balance-inquiry/proxy   ───────►  dsh-balance-inquiry/lib/index.js
  { url, method, headers, body,             │  fetch(url, …)
    timeoutSeconds }                        ▼
  ◄─────── { ok:true, status, body }     target site
  (same-origin request, no network hop, no CORS problem)
```

- The route is registered as an **exact route** by the host half's `lib/index.js` via
  `dsh-host-webserver`: `/plugins/dsh-balance-inquiry/proxy` (the exact table takes precedence
  over the `/plugins/<id>/` prefix route used by `dsh-client-modules`).
- In the desktop app, `dsh-app://app/plugins/...` is forwarded **as-is** to the host webserver by
  the Electron main process's `protocol.handle` (method, custom headers and request body are all
  preserved, and the session cookie is injected), so the renderer only needs a relative-path
  fetch. In the web version it is an ordinary same-origin HTTP request.
- The route only serves **local calls carrying a session cookie** and rejects non-HTTPS targets
  (except local `http://localhost`), URLs containing a username/password, and internal / loopback
  IPs. It is not an open proxy.
- The request body and headers are forwarded **verbatim**, so headers the browser forbids
  (`User-Agent`, etc.) really do go out when written in a custom script.
- When the host route is missing (older host, disabled webserver) the client **remembers that and
  falls back to a direct browser request**, so the feature still works without the host side.
- The bottom of **Settings → Balance Inquiry** shows the channel in use:
  `查询通道：DSH 宿主进程代理（不经过浏览器，无跨域限制）` or
  `查询通道：浏览器直连（目标站必须允许跨域，否则会被拦）`.

## Layout

```
dsh-balance-inquiry/
├── package.json        # dsh.bundle.patch + dsh.client.platform = web
├── cordis.patch.yml    # inserts the Loader entry
├── CHANGELOG.md        # Chinese changelog
├── CHANGELOG_en.md     # English changelog
├── docs/               # screenshots shown at the top of the READMEs
├── icon.svg
├── LICENSE             # MIT
├── locale/{zh,en}.json # strings (the same copy is inlined in client.js)
├── README.md           # Chinese README
├── README_en.md        # English README
├── NOTICE.md           # license and copyright notice
├── tools/              # install / self-test scripts (not copied into the profile)
│   ├── install-balance-plugin.cjs      # copy the package dir + patch the profile manifest
│   ├── register-profile-bundle.cjs     # register the package name in dsh.profile.bundles
│   ├── balance-smoke-test.cjs          # client bundle self-test
│   ├── balance-host-proxy-test.cjs     # host proxy self-test
│   ├── verify-balance-install.cjs      # install check (file-by-file diff source vs. installed)
│   └── sync-balance-locale.cjs         # sync the strings in client.js to locale/*.json
└── lib/
    ├── index.js        # host half: /plugins/dsh-balance-inquiry/proxy (fetch from Node, no CORS)
    ├── index.d.ts
    └── client.js       # everything else: sidebar entry + settings page + query engine + host-first with browser fallback
```

Version history: [`CHANGELOG_en.md`](./CHANGELOG_en.md) (English) ·
[`CHANGELOG.md`](./CHANGELOG.md) (Chinese).
