# DNS 分权管理面板

本项目使用 Cloudflare Workers 和 D1 实现 DNS 分权管理。受邀用户只需面板账号，无需 Cloudflare 账号；受限的 Cloudflare API Token 保存在 Worker 的运行时 Secret 中。管理员可以通过面板或 Cloudflare 控制台管理域名。

## 权限

| 档位 | 可见记录 | 可修改记录 |
| --- | --- | --- |
| 默认 `self` | 归该用户所有 | 获批名称范围内、归该用户所有 |
| 协作 `collaborate` | 全部 | 获批名称范围内、归该用户所有 |
| 代管 `delegate` | 全部 | 获批名称范围内的全部 |
| 只读 `readonly` | 全部 | 无 |

用户可以申请子域名范围，管理员批准后才能在该范围内创建或修改记录；管理员也可以直接分配范围。代管档可由管理员显式授予整个域名范围，降档时该全域授权会自动收回。批准范围不会自动创建 DNS 记录。管理员还可以按用户、按域名设置用户自有记录的数量上限、允许新增的 DNS 记录类型、代理开关、清缓存权限和记录变更审批要求。新邀请的用户默认允许新增 `A`、`AAAA`、`CNAME`、`TXT`，管理员可在策略中逐项调整；升级前已有策略保留全部当前支持类型的权限。类型限制适用于创建记录和把现有记录改成另一类型；仅修改原类型记录的内容或删除记录时，仍按档位、归属及名称范围判断。待审批的变更在执行前会重新校验当前权限与 Cloudflare 记录状态。

记录归属以 D1 为准，Cloudflare 记录标签仅辅助异常恢复。对账会把无法确认归属的外部记录标记为无主，交由管理员认领或分配；发现某条记录状态漂移时，会暂停用户修改该记录，等待管理员核对。浏览器不会直接调用 Cloudflare DNS API。

## 环境变量与密钥

生产环境要配置以下四个 Worker 运行时 Secret。它们都在 Worker 的 **Settings → Variables and Secrets** 中添加，类型选 **Secret**；不要放进仓库或 Git 构建变量。保存后 Cloudflare 不会再次显示 Secret 值，请把生成结果保存在自己的密码管理器中。

| 名称 | 值从哪里来 | 用途 |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | 按下方步骤创建的 Cloudflare API Token | 面板服务端读取和修改 DNS、按主机名清理缓存 |
| `SESSION_KEY` | 用下方命令生成的独立随机值 | 签名登录会话与 CSRF 校验；更换后所有现有会话都要重新登录 |
| `TOTP_KEY` | 用下方命令生成的独立随机值 | 加密 D1 中保存的 TOTP 密钥；必须保持原值，否则已启用 TOTP 的账号无法验证 |
| `BOOTSTRAP_KEY` | 用下方命令生成的独立随机值 | 首次创建管理员时输入的引导密钥；保留它以备重新初始化时使用 |

`CF_API_BASE` 不是生产环境配置项。代码默认使用 `https://api.cloudflare.com/client/v4`，生产 Worker 中不要添加它。`ACCOUNT_ID` 也不需要配置：面板使用域名的 Zone ID。

### 生成三个随机密钥

在自己的电脑终端运行以下命令。每次会为三项分别生成 32 字节随机值并以 base64url 格式输出；将三行结果分别复制到对应 Secret。不要互换或复用这些值。

```powershell
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
foreach ($name in @('SESSION_KEY', 'TOTP_KEY', 'BOOTSTRAP_KEY')) {
  $bytes = New-Object byte[] 32
  $rng.GetBytes($bytes)
  $value = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
  "$name=$value"
}
$rng.Dispose()
```

### 创建 `CLOUDFLARE_API_TOKEN`

在 Cloudflare 控制台打开 **My Profile → API Tokens → Create Token → Create Custom Token**。在权限列表中添加以下 Zone 权限：

- `Zone Read`
- `DNS Read`
- `DNS Write`
- `Cache Purge`

在 **Zone Resources** 中选择 **Include → Specific zone**，只勾选要由面板管理的域名。若之后还要管理其他域名，再把它们加入 Token 的 Zone Resources 范围。不要使用 Global API Key。[创建 API Token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/) · [权限列表](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)

创建完成后复制 Token 值，留待最后一步添加为 Worker Secret。应用只在服务端用它调用 Cloudflare DNS API。

### 查找域名的 Zone ID

在 Cloudflare 控制台选择要管理的域名，打开 **Overview**，在页面下方的 **API** 区域复制 **Zone ID**。[查找 Zone ID](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/)。这个 ID 不是 Secret，也不需要添加为 Worker 环境变量；部署后在面板的 **管理员 → 添加域名** 中粘贴，面板会用 `CLOUDFLARE_API_TOKEN` 验证它并扫描 DNS 记录。

## 本地开发

本地开发需要 Node.js 20 或更新版本。在项目根目录创建 `.dev.vars`（不要提交到 Git）。先用上面的命令生成三个密钥，再填入文件。此处的 Token 只是本地占位值，模拟 API 不会校验它；`CF_API_BASE` 指向仓库内的模拟 Cloudflare API：

```text
CLOUDFLARE_API_TOKEN=local-test-token
SESSION_KEY=<生成的 SESSION_KEY>
TOTP_KEY=<生成的 TOTP_KEY>
BOOTSTRAP_KEY=<生成的 BOOTSTRAP_KEY>
CF_API_BASE=http://127.0.0.1:8999/client/v4
```

打开两个终端。先在第一个终端启动模拟 Cloudflare API，并保持运行：

```sh
node test/mock-cloudflare.mjs
```

然后在第二个终端安装依赖并启动 Worker：

```sh
npm ci
npm run dev
```

打开 `http://127.0.0.1:8787`，首次页面会要求引导密钥；输入 `.dev.vars` 中的 `BOOTSTRAP_KEY`，创建用户名和至少 12 位密码的管理员。若要运行端到端测试，管理员用户名填写 `localadmin`。在管理员页添加模拟域名时，Zone ID 填 `test-zone`。本地 D1 会在首次 API 请求时自动建表，无需手动执行 SQL。运行 `npm run typecheck` 和 `npm test` 可进行静态检查和单元测试。

端到端测试 `npm run test:smoke` 使用上述本地数据库，要求管理员用户名为 `localadmin`、本地模拟 API 和 Worker 仍在运行。在 PowerShell 中运行：

```powershell
$env:SMOKE_ADMIN_PASSWORD = '<创建 localadmin 时设置的密码>'
npm run test:smoke
Remove-Item Env:SMOKE_ADMIN_PASSWORD
```

`SMOKE_ADMIN_PASSWORD` 只供本地测试脚本使用，不要添加到 Worker 设置。

## 生产部署：Cloudflare 控制台连接 Git 仓库

以下步骤使用 [Workers Builds Git 集成](https://developers.cloudflare.com/workers/ci-cd/builds/)，不创建 Pages 项目。先按上文准备面板使用的 API Token 和三个随机密钥；它们只在最后一步填入 Worker 设置。

1. 在 **Workers & Pages → Create application → Import a repository** 中选择 GitHub 或 GitLab，连接仓库并选择生产分支。**Worker 名称由你自己填写**，仓库配置没有固定名称；项目位于仓库根目录时，Root directory 保持默认值。
2. **Build command 留空**，**Deploy command 填 `npx wrangler deploy`**，然后保存并部署。项目无需额外构建命令，也无需自行配置构建 Token。[Workers Builds 设置](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)
3. 部署完成后，在该 Worker 的 **Settings → Bindings** 查看 D1 绑定：变量名应为 **`DB`**，指向自动创建的数据库。数据库名由所填 Worker 名称生成，例如 Worker 名为 `derekflare` 时显示 `derekflare-db`。仓库中的 `d1_databases` 配置负责自动创建并连接它；**不要再手工创建第二个数据库或执行 SQL**。应用首次收到 API 请求时会自动建表。本项目无需 R2、KV。[Cloudflare 自动配置资源说明](https://developers.cloudflare.com/changelog/post/2025-10-24-automatic-resource-provisioning/)
4. 最后打开该 Worker 的 **Settings → Variables and Secrets**，在生产环境逐项添加上表的四个名称，**Type 均选 Secret** 并粘贴相应的值；保存并按界面提示部署，使配置生效。[在控制台添加 Secret](https://developers.cloudflare.com/workers/configuration/secrets/#via-the-dashboard)

### 绑定面板域名并创建管理员

1. 该 Worker 将 `workers_dev` 设为 `false`。打开 Worker 的 **Settings → Domains & Routes → Add → Custom Domain**，填写专用于面板的主机名，例如 `dns.example.com`。此主机名不要同时用作普通网站记录；如控制台提示 DNS 记录冲突，先在该域名的 DNS 记录页处理冲突。[Custom Domain 文档](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
2. 使用 HTTPS 打开面板。首次打开会显示“创建管理员”：输入 `BOOTSTRAP_KEY`、3–40 位用户名，以及至少 12 位密码。管理员创建后，引导页面即关闭。
3. 在面板的 **管理员 → 添加域名** 中粘贴前面查到的 Zone ID。验证通过后，面板执行首次 DNS 对账。之后可创建用户邀请、设置逐人逐域名策略；邀请链接只显示一次，需手动复制发送。

Cloudflare 账号所有者仍可直接修改 DNS 和 D1。面板审计日志用于追踪经面板执行的操作，不能阻止账号所有者绕过面板或篡改 D1。

## 管理说明

- 邀请链接只显示一次，24 小时有效，不提供自助注册或邮件发送。忘记密码时管理员可生成新的找回链接；找回期间原会话立即吊销。
- 停用账号会立即吊销所有面板会话与未使用邀请；删除账号还会把其 DNS 记录标记为无主，供管理员认领或重新分配，记录本身不会删除。已经发往 Cloudflare 的请求可能完成，后续请求会被拒绝。
- 用户只能清理获批范围内、且该主机名的 DNS 记录均归其所有的缓存；不提供全域清理。
- “不可见”仅指本面板及其 API。公开 DNS 查询依然可能得到 DNS 记录；这套入口不提供 DNS 数据保密性。
