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
npm run dev
```

本地面板地址为 `http://127.0.0.1:8787`。D1 本地数据库会在首次 API 请求时自动初始化。首次打开时，使用 `BOOTSTRAP_KEY` 创建管理员；生产面板仅使用 HTTPS。可在 `.dev.vars` 中把 `CF_API_BASE` 指向本地模拟服务，以免测试请求触及真实域名。运行 `npm run typecheck` 和 `npm test` 检查代码；`test/mock-cloudflare.mjs` 与 `test/smoke.mjs` 用于本地端到端验证，后者要求预先创建用户名为 `localadmin` 的测试管理员，并通过 `SMOKE_ADMIN_PASSWORD` 提供其密码。

## 生产部署

面板调用 Cloudflare DNS API 使用运行时 Secret `CLOUDFLARE_API_TOKEN`。为它配置目标域名所需的权限：`Zone Read`、`DNS Read`、`DNS Write`；启用清缓存功能时还需要 `Cache Purge`。用户不需要 Cloudflare 账号或 API 凭证。

通过 Git 集成部署时，Worker 名称由你在 Cloudflare 控制台填写，不必修改仓库。Workers Builds 会将部署指向已连接的 Worker。[Cloudflare 构建名称说明](https://developers.cloudflare.com/workers/ci-cd/builds/troubleshoot/#workers-name-requirement)

### 使用 Cloudflare 控制台连接 GitHub / GitLab

此方式使用 [Workers Builds 的 Git 集成](https://developers.cloudflare.com/workers/ci-cd/builds/)部署 Worker，不需要创建 Pages 项目。集成支持 GitHub 和 GitLab.com，不支持自托管 GitLab。不要提交 `.dev.vars` 或任何密钥。

1. 在 **Workers & Pages → Create application → Import a repository** 中选择 GitHub 或 GitLab，并授权、选择仓库和生产分支。Worker 名称由你填写。项目位于仓库根目录时沿用默认 **Root directory**；位于子目录时填写项目目录。
2. 设置 **Build command** 为空、**Deploy command** 为 `npx wrangler deploy`，然后创建并部署 Worker。[Workers Builds Git 集成](https://developers.cloudflare.com/workers/ci-cd/builds/)、[构建设置](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
3. Worker 创建后，在 **Settings → Bindings** 中创建 D1 数据库并连接到 Worker，绑定名称填写 `DB`。Worker 首次处理 API 请求或定时任务时，会在数据库中初始化或升级表结构。
4. 最后在 **Settings → Variables and Secrets** 添加运行时 Secret：`CLOUDFLARE_API_TOKEN`、`SESSION_KEY`、`TOTP_KEY`、`BOOTSTRAP_KEY`。`TOTP_KEY` 使用 32 字节随机值的 base64url 编码，其余密钥也分别使用随机值。不要把密钥放入仓库或构建变量。[设置运行时 Secret](https://developers.cloudflare.com/workers/configuration/secrets/#via-the-dashboard)

### 部署完成后

1. 此项目将 `workers_dev` 设为 `false`。在 Worker 的 **Domains & Routes** 中添加专用于面板的 Custom Domain，例如 `dns.example.com`；该主机名不应再分配给普通用户。若该名称已有 CNAME，先解决冲突。[Custom Domain 文档](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
2. 打开面板，使用 `BOOTSTRAP_KEY` 创建管理员。在后台添加目标域名的 Zone ID；系统会核对域名并执行首次对账。随后创建用户邀请，设置逐人逐域名策略。用户接受邀请后可申请子域名范围，也可由管理员直接分配。
审计日志可在面板中分页查看；Cloudflare 账号所有者仍能直接修改 D1，因此审计日志不能防止账号所有者篡改。

## 管理说明

- 邀请链接只显示一次，24 小时有效，不提供自助注册或邮件发送。忘记密码时管理员可生成新的找回链接；找回期间原会话立即吊销。
- 停用账号会立即吊销所有面板会话与未使用邀请；删除账号还会把其 DNS 记录标记为无主，供管理员认领或重新分配，记录本身不会删除。已经发往 Cloudflare 的请求可能完成，后续请求会被拒绝。
- 用户只能清理获批范围内、且该主机名的 DNS 记录均归其所有的缓存；不提供全域清理。
- “不可见”仅指本面板及其 API。公开 DNS 查询依然可能得到 DNS 记录；这套入口不提供 DNS 数据保密性。
