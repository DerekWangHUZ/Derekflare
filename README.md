# DNS 分权管理面板

基于 Cloudflare Workers + D1 的自托管 DNS 管理入口。朋友仅持有面板账号；Cloudflare Token 只由 Worker 使用。管理员始终可以直接使用 Cloudflare 控制台。

## 权限

| 档位 | 可见记录 | 可修改记录 |
| --- | --- | --- |
| 默认 `self` | 本人拥有 | 本人拥有 |
| 协作 `collaborate` | 全部 | 本人拥有 |
| 代管 `delegate` | 全部 | 全部 |
| 只读 `readonly` | 全部 | 无 |

朋友可自行申请子域名后缀，但只有管理员批准后才能在其中创建记录。管理员也可直接分配；代管档可由管理员显式分配整个域名，降档时该全域范围会自动收回。范围申请的批准不创建 DNS 记录。每位朋友、每个域名还分别有记录数量、代理、缓存清理和记录变更审批配置。审批中的记录变更在执行前会重新校验当前权限与 Cloudflare 状态。

记录归属以 D1 为准，Cloudflare 记录标签只辅助异常恢复。对账会把无法确认归属的外部记录登记给管理员；发现记录内容漂移时暂停朋友写入，待管理员核对。任何 DNS API 请求都不会由浏览器直接发给 Cloudflare。

## 本地开发

需要 Node.js 20+。安装依赖后创建不提交的 `.dev.vars`：

```text
CLOUDFLARE_API_TOKEN=<仅测试域名的 Token>
SESSION_KEY=<至少 32 字节随机密钥>
TOTP_KEY=<32 字节随机值的 base64url 编码>
BOOTSTRAP_KEY=<至少 32 字节随机引导密钥>
```

```sh
npm ci
npx wrangler d1 migrations apply dns-delegation-panel --local
npm run dev
npm run typecheck
npm test
```

本地面板在 `http://127.0.0.1:8787`。首次访问会要求输入 `BOOTSTRAP_KEY` 创建管理员；生产上仅使用 HTTPS。测试 Cloudflare API 时可在 `.dev.vars` 中把 `CF_API_BASE` 指向本地模拟服务；生产配置默认固定为官方 API 地址。`test/mock-cloudflare.mjs` 和 `test/smoke.mjs` 可用于本地端到端验证，后者需要已经创建名为 `localadmin` 的测试管理员，并通过 `SMOKE_ADMIN_PASSWORD` 环境变量提供其测试密码。

## 生产部署

### 使用 Cloudflare 控制台连接 GitHub / GitLab

此方式使用 [Workers Builds 的 Git 集成](https://developers.cloudflare.com/workers/ci-cd/builds/)部署 **Worker**，不需要创建 Pages 项目，也不需要手动创建 D1 或粘贴 SQL。Cloudflare 支持 GitHub 和 GitLab.com 仓库；自托管 GitLab 不在此集成的支持范围内。请先把本项目推送到仅由可信维护者管理的仓库，保留项目根目录的 `wrangler.jsonc`、`package-lock.json`、`migrations/` 和 `scripts/deploy.mjs`，不要提交 `.dev.vars` 或任何密钥。

1. 在 **Workers & Pages** 中先创建一个名为 `dns-delegation-panel` 的 Worker。到该 Worker 的 **Settings → Variables and Secrets**，添加四个**运行时 Secret**：`CLOUDFLARE_API_TOKEN`、`SESSION_KEY`、`TOTP_KEY`、`BOOTSTRAP_KEY`。DNS Token 仅授权指定域名的 `Zone Read`、`DNS Read`、`DNS Write`（需要清缓存时再加 `Cache Purge`）；`TOTP_KEY` 是 32 字节随机值的 base64url 编码，其他密钥也独立随机生成。不要把这些值放进 Git 或 Builds 的构建变量。[Secret 控制台设置](https://developers.cloudflare.com/workers/configuration/secrets/#via-the-dashboard)
2. 在这个 Worker 的 **Settings → Builds → Connect** 中选择 GitHub 或 GitLab，按提示授权并选择仓库及生产分支。项目在仓库根部时保留默认的 **Root directory**；若放在子目录，则填写包含 `wrangler.jsonc` 的目录。Worker 名称必须与配置中的 `name` 一致。**Build command** 留空，**Deploy command** 填 `npm run deploy`。[连接现有 Worker](https://developers.cloudflare.com/workers/ci-cd/builds/#connect-an-existing-worker)、[构建设置](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
3. 在 Worker 的 **Settings → Builds → API token** 确认构建使用的 Token，再到 **My Profile → API Tokens** 给它增加此账号的 **D1 Edit** 权限，并保留原有 Workers 部署权限。Cloudflare 默认构建 Token 不含 D1 Edit。这个构建 Token 与上一步仅限指定域名的运行时 DNS Token 是两套凭证，不能互用。配置好后向生产分支推送一次提交，触发首次构建；如连接仓库时已经触发构建，则修改 Token 后重试。[构建 Token 权限](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/#api-token)、[D1 Edit 权限](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)
4. `npm run deploy` 首次运行时先由 Wrangler 自动创建并绑定 D1，随后自动执行 `migrations/` 中尚未应用的迁移；以后每次构建先迁移再部署新版本。无需填写 `database_id` 或操作 D1 Console。若任一步失败，构建会报错，应先查看 **Builds** 日志，不要手动重复运行 SQL。[自动创建资源](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning)、[D1 迁移](https://developers.cloudflare.com/d1/reference/migrations/)
5. 在 **Builds** 中确认部署成功，并检查 Worker 的 `DB` 绑定与四个 Secret。此项目的 `workers_dev` 为 `false`；在 **Domains & Routes** 添加专用于管理面板的 Custom Domain 后再访问。随后按下方第 4–5 步创建管理员、添加 Zone ID 并先完成测试。保持非生产分支预览构建关闭；若需开启，先为预览单独配置 D1 与受限测试 Token，避免预览代码接触生产 DNS。[预览资源说明](https://developers.cloudflare.com/workers/previews/resources/)

### 使用 Wrangler 命令行

1. 在 Cloudflare 为**指定域名**创建 API Token，授予 `Zone Read`、`DNS Read`、`DNS Write`，如要使用清缓存功能再授予 `Cache Purge`。确认朋友没有该账号的 Cloudflare 成员身份或其他可直连凭证。
2. 使用 `npx wrangler secret put` 分别设置 `CLOUDFLARE_API_TOKEN`、`SESSION_KEY`、`TOTP_KEY`、`BOOTSTRAP_KEY`。四项均不得写入 `wrangler.jsonc`、Git 或前端文件。`TOTP_KEY` 必须是 32 字节随机值的 base64url 编码；其他密钥也应独立随机生成。
3. 运行 `npm ci` 和 `npm run deploy`，自动创建或绑定 D1、执行尚未应用的迁移并部署 Worker。成功后在 **Domains & Routes** 中添加你指定的 Custom Domain，例如 `dns.example.com`。该主机名应保留给管理员，不能作为朋友的授权范围；若已有 CNAME，先处理其冲突。[Custom Domain 文档](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
4. 打开面板，用 `BOOTSTRAP_KEY` 创建唯一管理员。在后台添加 Zone ID；此操作会先核对 Cloudflare 域名并进行初次全量对账。随后创建邀请、设置逐人逐域名策略。朋友接受邀请后可申请子域名，或由管理员直接分配。
5. 先在专用测试子域名跑通申请、审批、增改删、降档、停用和对账，再邀请正式用户。

建议在正式域名之外先使用单独的测试 Worker 与 D1 数据库。每次变更配置后运行 `npx wrangler types` 更新 `worker-configuration.d.ts`，再执行 `npm run typecheck`、`npm test` 和 `npm run deploy:check`。审计日志由应用追加保存并可分页查看；Cloudflare 账号所有者仍可直接操作 D1，因此它不是防管理员篡改的独立审计系统。

## 管理说明

- 邀请链接只显示一次，24 小时有效，不提供自助注册或邮件发送。忘记密码时管理员可生成新的找回链接；找回期间原会话立即吊销。
- 停用账号立即吊销所有面板会话与未使用邀请；删除账号还会把其记录归属回收到管理员，DNS 记录不会自动删除。已在执行中的 Cloudflare 请求可能完成，后续请求会被拒绝并由对账发现状态变化。
- 清缓存仅支持授权范围内、由本人拥有的主机名，不提供朋友侧全域清理。
- “不可见”仅指本面板及其 API。公开 DNS 查询依然可能得到 DNS 记录；这套入口不提供 DNS 数据保密性。
