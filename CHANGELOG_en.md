# Changelog

English ｜ [简体中文](./CHANGELOG.md)

## 0.4.4

- **Secure Provider ID Binding & Automatic Switching**:
  - Removed sniffing/retrieving `baseURL` and sensitive network configuration in the host.
  - Added restricted read-only route `GET /plugins/dsh-balance-inquiry/providers` to safely return configured provider IDs and display names.
  - Accounts can link to a provider ID defined in DSH `cordis.patch.yml` (`dshProviderId`).
  - When switching models/providers in DSH, the bottom-left sidebar entry automatically detects the switch and displays the corresponding plan's balance; falls back to the most critical plan when unmatched.

## 0.4.1

- Added the English docs [`README_en.md`](./README_en.md) and
  [`CHANGELOG_en.md`](./CHANGELOG_en.md); the Chinese files now carry an "English" language
  switch at the top.
- Both English files are shipped inside the npm package.

## 0.4.0

- **Multiple plans**: one plan = one configuration (provider / billing type / token / endpoint /
  website). The "Add plan" dialog asks for the billing type first (pay-as-you-go API key or
  Token Plan / Coding Plan) and then the provider; the plans you added line up as bars on the
  level-1 settings page (plan name + remaining balance), and clicking one opens a level-2 edit
  page.
- **Auto detection removed**: the `auto` query mode and the address sniffing are gone; the
  provider is specified explicitly per plan and the address no longer takes part in the decision.
- **Balance board**: the sidebar button **left click** opens the board (`shell.overlay`), where
  every plan is a rounded rectangle card showing the plan name, remaining balance and last query
  time; **left click** a card to open that plan's provider site. The board also lets you add a
  plan and refresh immediately. Press Esc or click the backdrop to close.
- **Plans billed in credits / points no longer show the quota conversion rate**: only New API and
  custom scripts display "conversion rate / currency unit".
- **Current provider**: the host half gained a read-only route
  `GET /plugins/dsh-balance-inquiry/whoami`, which reads `agentDefaultModel` and the current
  provider's `baseURL` (no secrets); the "Add plan" dialog pins a one-click
  "Use the provider in use now" entry.
- Storage split into three keys: `dsh-balance-inquiry:accounts` (plans), `:settings` (global
  settings) and `:results` (each plan's last reading). A legacy single-plan configuration is
  converted into one plan on first read.
- Self-tests: 236 client assertions, 27 host-half assertions, and a 22-assertion file-by-file
  install check.

## 0.3.3

- Took the current implementation as the baseline and cleared the historical baggage: removed the
  old configuration migration (per-second `refreshSeconds` → per-minute `autoQueryInterval`), the
  old storage-key (`dsh-quota:*`) migration, the old factory-address cleanup, and the old
  package-name cleanup in the install script.
- Trimmed comments to functional notes only: dropped provenance and history remarks; `NOTICE.md`
  now only states the license and copyright, and `LICENSE` keeps just the MIT text.
- Removed the README's "reinstall / recover" and "credits and license" sections along with the
  migration and rename notes.
- Self-tests: 219 client assertions, 22 host-proxy assertions, and a file-by-file install check.

## 0.3.2

- No site is preset at the factory any more: `baseUrl` / `websiteUrl` default to empty and no
  request is sent while the address is blank. The settings status line now distinguishes
  "endpoint not filled in yet" from "access token not filled in yet".
- When both the address and the access token are empty, the sidebar button only refreshes and does
  not navigate.

## 0.3.1

- The install instructions now use the official command
  `dsh plugin --profile desktop add dsh-balance-inquiry`; `files` gained `docs/*.png` and
  `CHANGELOG.md`.

## 0.3.0

- Added usage queries for 8 coding plans (Token Plan / Coding Plan), with time windows normalized
  to 5-hour / weekly / monthly.
- Renamed the plugin to `dsh-balance-inquiry`, with a new icon and settings-page name.
- Added the host-half proxy route: when a direct browser request is blocked by CORS, the request
  is sent by the host process instead.

## 0.2.0

- Added six native balance endpoints — New API, DeepSeek, StepFun, SiliconFlow, OpenRouter,
  Novita — plus custom usage scripts.
- keep-last-good: on a transient failure the last successful balance keeps showing for 10 minutes.
- Multiple plans and currencies, a sidebar tooltip, a configurable website, an auto-refresh
  interval and a request timeout.

## 0.1.0

- First release: shows "剩余额度：XXX ￥" at the bottom of the sidebar; clicking it opens the
  provider site.
