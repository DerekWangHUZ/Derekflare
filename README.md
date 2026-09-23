# DNS 分权管理面板

本项目使用 Cloudflare Workers 和 D1 实现 DNS 分权管理。受邀用户只需面板账号，无需 Cloudflare 账号；受限的 Cloudflare API Token 保存在 Worker 的运行时 Secret 中。管理员可以通过面板或 Cloudflare 控制台管理域名。

## 权限

| 档位 | 可见记录 | 可修改记录 |
| --- | --- | --- |
| 默认 `self` | 归该用户所有 | 获批名称范围内、归该用户所有 |
| 协作 `collaborate` | 全部 | 获批名称范围内、归该用户所有 |
| 代管 `delegate` | 全部 | 获批名称范围内的全部 |
| 只读 `readonly` | 全部 | 无 |

用户可以申请子域名范围，管理员批准后才能在该范围内创建或修改记录；管理员也可以直接分配范围。代管档可由管理员显式授予整个域名范围，降档时该全域授权会自动收回。批准范围不会自动创建 DNS 记录。管理员还可以按用户、按域名设置用户自有记录的数量上限、代理开关、清缓存权限和记录变更审批要求。待审批的变更在执行前会重新校验权限与 Cloudflare 记录状态。

记录归属以 D1 为准，Cloudflare 记录标签仅辅助异常恢复。对账会把无法确认归属的外部记录标记为无主，交由管理员认领或分配；发现某条记录状态漂移时，会暂停用户修改该记录，等待管理员核对。浏览器不会直接调用 Cloudflare DNS API。

## 本地开发

需要 Node.js 20 或更新版本。在项目根目录创建不提交到 Git 的 `.dev.vars`：

```text
CLOUDFLARE_API_TOKEN=<仅测试域名的 Token>
SESSION_KEY=<至少 32 字节随机密钥>
TOTP_KEY=<32 字节随机值的 base64url 编码>
BOOTSTRAP_KEY=<至少 32 字节随机引导密钥>
```

```sh
npm ci
npx wrangler d1 migrations apply DB --local
npm run dev
```

本地面板地址为 `http://127.0.0.1:8787`。首次打开时，使用 `BOOTSTRAP_KEY` 创建管理员；生产面板仅使用 HTTPS。可在 `.dev.vars` 中把 `CF_API_BASE` 指向本地模拟服务，以免测试请求触及真实域名。运行 `npm run typecheck` 和 `npm test` 检查代码；`test/mock-cloudflare.mjs` 与 `test/smoke.mjs` 用于本地端到端验证，后者要求预先创建用户名为 `localadmin` 的测试管理员，并通过 `SMOKE_ADMIN_PASSWORD` 提供其密码。

## 生产部署

部署前，创建仅授权目标域名的 Cloudflare API Token：需要 `Zone Read`、`DNS Read`、`DNS Write`，启用清缓存功能时再添加 `Cache Purge`。确认受邀用户没有该域名的 Cloudflare 成员权限或可直接调用 Cloudflare API 的其他凭证。

通过 Git 集成部署时，**Worker 名称由你在 Cloudflare 控制台填写**，不必修改仓库。`wrangler.jsonc` 中的 `name` 仅是直接使用 Wrangler 命令行时的默认名称；Cloudflare Workers Builds 会把已连接 Worker 的名称传给 Wrangler 用于部署。D1 数据库名称由 `database_name` 单独配置，与 Worker 名称无关。[Cloudflare 关于构建名称覆盖的说明](https://developers.cloudflare.com/workers/ci-cd/builds/troubleshoot/#workers-name-requirement)

### 使用 Cloudflare 控制台连接 GitHub / GitLab

此方式使用 [Workers Builds 的 Git 集成](https://developers.cloudflare.com/workers/ci-cd/builds/)部署 Worker，不需要创建 Pages 项目。集成支持 GitHub 和 GitLab.com，不支持自托管 GitLab。请将项目推送到仅由可信维护者管理的仓库，保留 `wrangler.jsonc`、`package-lock.json`、`migrations/` 和 `scripts/deploy.mjs`，不要提交 `.dev.vars` 或密钥。

1. 在 **Workers & Pages** 中创建 Worker，自行填写名称。在 **Settings → Variables and Secrets** 添加四个**运行时 Secret**：`CLOUDFLARE_API_TOKEN`、`SESSION_KEY`、`TOTP_KEY`、`BOOTSTRAP_KEY`。`TOTP_KEY` 为 32 字节随机值的 base64url 编码，其他密钥也须独立随机生成。不要把密钥放入仓库或 Builds 的构建变量。[设置运行时 Secret](https://developers.cloudflare.com/workers/configuration/secrets/#via-the-dashboard)
2. 在该 Worker 的 **Settings → Builds → Connect** 中选择 GitHub 或 GitLab，授权仓库并选择生产分支。项目位于仓库根目录时沿用默认 **Root directory**；位于子目录时填写包含 `wrangler.jsonc` 的目录。**Build command** 留空，**Deploy command** 填 `npm run deploy`。[连接现有 Worker](https://developers.cloudflare.com/workers/ci-cd/builds/#connect-an-existing-worker)、[构建设置](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
3. 在 **Settings → Builds → API token** 查看构建使用的 Token，并在 **My Profile → API Tokens** 为它补充该账号的 **D1 Edit** 权限，保留原有 Workers 部署权限。默认构建 Token 不含 D1 Edit。构建 Token 与运行时的域名 DNS Token 分开保管，不提供给面板用户。配置好后向生产分支推送一次提交；若连接仓库时已触发构建，则在更新 Token 后重试。[构建 Token 权限](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/#api-token)、[D1 Edit 权限](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)
4. `npm run deploy` 首次运行会自动创建并绑定 D1，再执行尚未应用的数据库迁移；后续构建先迁移，再部署新版 Worker。无需填写 `database_id` 或在 D1 Console 执行 SQL。构建失败时查看 **Builds** 日志，排除错误后重试。[自动创建资源](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning)、[D1 迁移](https://developers.cloudflare.com/d1/reference/migrations/)
5. 构建成功后，检查 Worker 的 `DB` 绑定和四个 Secret，再按下文“部署完成后”设置面板域名。先关闭非生产分支预览构建；如要启用，须为预览配置独立的 D1 和测试 Token，避免预览代码访问生产 DNS。[预览资源说明](https://developers.cloudflare.com/workers/previews/resources/)

### 使用 Wrangler 命令行

1. 运行 `npm ci`，然后分别用 `npx wrangler secret put` 设置上述四个运行时 Secret。密钥格式与控制台部署相同，不要写入 `wrangler.jsonc`、Git 或前端文件。直接使用 Wrangler 命令行时，默认部署到 `wrangler.jsonc` 的 `name` 所指定的 Worker；这一默认值不影响上面的 Git 集成部署。
2. 运行 `npm run deploy`，自动创建或绑定 D1、执行尚未应用的迁移并部署 Worker。随后按下文设置面板域名。

### 部署完成后

1. 此项目将 `workers_dev` 设为 `false`。在 Worker 的 **Domains & Routes** 中添加专用于面板的 Custom Domain，例如 `dns.example.com`；该主机名不应再分配给普通用户。若该名称已有 CNAME，先解决冲突。[Custom Domain 文档](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
2. 打开面板，使用 `BOOTSTRAP_KEY` 创建管理员。在后台添加目标域名的 Zone ID；系统会核对域名并执行首次对账。随后创建用户邀请，设置逐人逐域名策略。用户接受邀请后可申请子域名范围，也可由管理员直接分配。
3. 先用专用测试域名和仅限测试域名的 Token 验证申请、审批、DNS 变更、降档、停用及对账，再接入生产域名并发出正式邀请。

变更绑定配置后，运行 `npx wrangler types` 更新 `worker-configuration.d.ts`，并执行 `npm run typecheck`、`npm test` 和 `npm run deploy:check`。审计日志可在面板中分页查看；Cloudflare 账号所有者仍能直接修改 D1，因此审计日志不能防止账号所有者篡改。

## 管理说明

- 邀请链接只显示一次，24 小时有效，不提供自助注册或邮件发送。忘记密码时管理员可生成新的找回链接；找回期间原会话立即吊销。
- 停用账号会立即吊销所有面板会话与未使用邀请；删除账号还会把其 DNS 记录标记为无主，供管理员认领或重新分配，记录本身不会删除。已经发往 Cloudflare 的请求可能完成，后续请求会被拒绝。
- 用户只能清理获批范围内、且该主机名的 DNS 记录均归其所有的缓存；不提供全域清理。
- “不可见”仅指本面板及其 API。公开 DNS 查询依然可能得到 DNS 记录；这套入口不提供 DNS 数据保密性。
