# 轻传 · RELAY

轻量级、自托管的文件传输助手。使用 Material Design 3 中文界面，通过账号和配对码创建分享空间，支持全员共享、指定成员发送以及文件到期自动删除。

桌面与手机界面预览见 [桌面截图](docs/desktop-preview.jpg) 和 [手机截图](docs/mobile-preview.jpg)，截图数据来自独立测试环境。

也支持直接通过面板托管 Node.js，无需 Docker；通用步骤见 [面板部署](deploy/DEPLOYMENT.md)。运行 `npm run package:server` 可生成包含前端成品和精简运行依赖的服务器部署包。

## 已实现

- 用户名和密码注册／登录、跨设备会话、可完全关闭公开注册。
- 多房间、8 位配对码、创建者自动成为管理员、配对码重置。配对码只返回给管理员。
- 首页、工作空间房间列表和房间详情分别导航，支持返回按钮、顶部路径与浏览器前进／后退。
- 批量拖拽上传、逐文件进度、取消与失败重试；默认同时上传 2 个文件、同时下载 2 个文件。
- 全员文件可被后来加入的成员下载；定向文件只对发送者和指定接收人可见、可下载。
- 收到的文件／我发送的、名称搜索、分页、下载。发送者可以删除自己的文件；管理员可以删除房间内任何未过期文件，包括自己不能下载的定向文件。管理员列表里这些文件标记为不可下载，不显示接收人。
- 管理员可以移出其他成员。普通成员可以离开房间。管理员不能离开，本版也不转让管理员。
- 管理员设置新文件的有效期：1 小时、24 小时、7 天或 30 天；旧文件不变。房间设置里可查看最近 50 条活动，记录不含配对码或 Cookie。
- 服务端立即禁止下载过期文件。清理每批最多 100 条，在开始监听之后执行，之后每分钟继续。
- 单文件、房间和全站配额。用量记在内存里，上传按数据块预留；清理时从数据库重载，所以命令行删文件后大约一分钟内会与数据库对齐。
- 修改密码会保留当前会话并撤销其他会话。可以查看并退出已登录设备，每个账号最多保留 10 个会话。
- 桌面侧栏与手机抽屉导航、移动端文件卡片、键盘操作与减少动效支持。窄屏仍显示房间存储用量。

同一文件发送给多人只存一份。文件名会去掉 Unicode 格式字符和控制字符，避免双向文本把扩展名藏起来。同一数据目录只能有一个服务进程，第二进程会因 `relay.lock` 退出。密码重置和管理命令不占这把锁。

本版不含邮件找回密码、断点续传、转让管理员、解散房间、对象存储或多实例服务。

## 本地运行

需要 **Node.js 24.x**。不需要外部数据库或邮件服务。

```powershell
npm ci
npm run dev
```

打开终端显示的 Vite 地址（默认 `http://127.0.0.1:5173`）。开发 API 在 3001 端口，Vite 代理 `/api`。开发时不必复制 `.env.example`：默认开放注册，并用 HTTP。未设置 `PUBLIC_ORIGIN` 时，变更请求的来源可以是本机任意端口，因此 Vite 5173 可以访问 API。

如果项目根目录已经有生产 `.env`，本地开发需要把 `PUBLIC_ORIGIN` 改成 Vite 的实际地址，或先移开该文件，同时使用 `COOKIE_SECURE=false`、`TRUST_PROXY=0`。示例配置把注册关掉了，直接拿来启动时不能在网页上注册，要用下面的管理命令建号。

本地运行生产构建：

```powershell
npm run build
npm start
```

打开 `http://localhost:3001`。`npm start`、`npm run dev`、密码重置和管理命令会自动读取项目根目录 `.env`（若存在）。默认数据位于 `./data`，已加入忽略清单。

## Docker 部署

1. 复制配置并修改域名：

   ```sh
   cp .env.example .env
   # 修改 PUBLIC_ORIGIN=https://files.example.com 为实际访问域名
   # 若希望网页开放注册，把 REGISTRATION_ENABLED 改为 true
   docker compose up -d --build
   ```

2. 将 HTTPS 反向代理指向 `127.0.0.1:3001`。Compose 默认只绑定回环地址，容器以非 root 的 `node` 用户运行，数据保存在 `relay-data` 命名卷中。
3. 示例配置关闭注册。在容器外准备密码，用管理命令创建第一个账号，然后访问域名登录并创建房间。用户名需为 2–24 位文字、数字、下划线或短横线，密码为 10–128 个字符。
4. 检查服务：

   ```sh
   docker compose ps
   docker compose logs --tail=100 relay
   curl --fail http://127.0.0.1:3001/api/health
   ```

`PUBLIC_ORIGIN` 是用户实际访问的完整来源（协议、域名、必要时含端口，不含路径）；生产环境必须设置。只有它以 `https:` 开头时才发送 HSTS。生产环境默认启用 Secure Cookie。若仅在可信内网使用 HTTP，需显式设置 `PUBLIC_ORIGIN=http://实际地址` 和 `COOKIE_SECURE=false`，并自行调整端口绑定。

变更请求必须带 `Origin`。设置了 `PUBLIC_ORIGIN` 时，来源必须与它完全一致；未设置时，允许与当前 Host 相同，或双方都是 localhost、127.0.0.1、::1（端口不限）。缺少来源，或 `Sec-Fetch-Site: cross-site`，都会返回 403。

### Nginx 示例

用现有证书替换路径。应用使用普通流式上传，代理应关闭上传请求缓冲，避免将整份文件先写入代理临时目录。

```nginx
server {
    listen 80;
    server_name files.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name files.example.com;
    ssl_certificate /etc/letsencrypt/live/files.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/files.example.com/privkey.pem;

    # 应略大于 MAX_FILE_BYTES，为 multipart 边界留出空间。
    client_max_body_size 1025m;
    client_body_timeout 1800s;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        # 单层代理覆盖此头，避免信任客户端伪造的链。
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_request_buffering off;
        proxy_buffering off;
        proxy_read_timeout 1800s;
        proxy_send_timeout 1800s;
    }
}
```

默认上传请求最长 30 分钟。未通过鉴权的上传会在返回错误后断开未读完的连接，而不是一直占到这个上限。`TRUST_PROXY=1` 适用于前方恰好一层可信反向代理，并应限制后端仅能通过代理访问；直接运行时使用 `0`。多个反向代理需调整信任跳数并保证代理链不会被绕过。

### 配置项

| 变量                       | 默认值                    | 说明                                                                                            |
| -------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------- |
| `PORT` / `HOST`            | `3001` / `0.0.0.0`        | 监听地址；示例配置改为 `127.0.0.1`。Compose 在容器内固定为 `0.0.0.0:3001`，宿主机只发布回环端口 |
| `DATA_DIR`                 | `./data`                  | 数据目录；Compose 固定为 `/app/data`                                                            |
| `PUBLIC_ORIGIN`            | 开发时按请求推导          | 生产必填，也是来源校验和 HSTS 的依据                                                            |
| `REGISTRATION_ENABLED`     | `true`                    | 设为 `false` 后网页不能注册，包括还没有用户时。第一个账号用管理命令创建                         |
| `COOKIE_SECURE`            | 生产 `true`，开发 `false` | 是否仅通过 HTTPS 发送会话 Cookie                                                                |
| `TRUST_PROXY`              | `0`                       | 可信代理跳数；示例 `.env` 为 `1`                                                                |
| `MAX_FILE_BYTES`           | `1073741824`              | 单文件 1 GiB                                                                                    |
| `MAX_BATCH_FILES`          | `20`                      | 界面单批文件数量上限，每个文件一个上传请求                                                      |
| `MAX_CONCURRENT_UPLOADS`   | `2`                       | 每账号并发上传上限，界面使用相同并发数                                                          |
| `MAX_CONCURRENT_DOWNLOADS` | `2`                       | 每账号并发下载上限                                                                              |
| `ROOM_QUOTA_BYTES`         | `10737418240`             | 单房间 10 GiB                                                                                   |
| `TOTAL_QUOTA_BYTES`        | `53687091200`             | 全站 50 GiB；过期文件成功删除前仍占容量                                                         |
| `SESSION_DAYS`             | `30`                      | 固定会话有效天数；重新登录创建新会话，超出 10 个时丢掉最旧的                                    |

修改 `.env` 后，运行 `docker compose up -d --force-recreate` 应用配置。单实例运行，不能让多个应用进程共用数据目录。容量配置是应用数据上限，应给操作系统、SQLite 和临时开销留出磁盘余量。

### 账号管理

无邮件找回功能。密码从标准输入读取，不使用命令行明文参数。

停用账号会立刻删掉该用户的全部会话。恢复后需要重新登录。删除某用户发送的全部文件时，先删数据库再删磁盘；若服务正在运行，内存用量会在下一分钟校正。

Linux / Docker（在项目目录，用隐藏输入避免写入 shell 历史）：

```sh
read -rsp '新密码（至少10位）: ' relay_password; echo
printf '%s' "$relay_password" | docker compose exec -T relay node server/reset-password.mjs 用户名
printf '%s' "$relay_password" | docker compose exec -T relay node server/admin.mjs create-user 新用户名
docker compose exec -T relay node server/admin.mjs disable 用户名
docker compose exec -T relay node server/admin.mjs enable 用户名
docker compose exec -T relay node server/admin.mjs delete-files 用户名
unset relay_password
```

Windows / 本地 Node：

```powershell
$relayCredential = Get-Credential -UserName '用户名' -Message '输入要重置的账号及新密码'
$relayCredential.GetNetworkCredential().Password | npm run reset-password -- $relayCredential.UserName
$relayCredential.GetNetworkCredential().Password | npm run admin -- create-user 新用户名
Remove-Variable relayCredential
npm run admin -- disable 用户名
```

密码重置修改现有账号。`create-user` 才创建新账号。面板部署包里的对应命令是 `node --env-file=.env server/admin.mjs`。

已登录用户也可以在「账号与安全」里修改自己的密码。保存后当前浏览器保持登录，其他会话失效。

### 备份与恢复

同时备份数据库和文件，推荐停服后打包整个数据卷，保证 SQLite WAL 与磁盘文件一致。备份包含用户密码哈希、会话和上传内容，应限制访问。

```sh
docker compose stop relay
docker compose run --rm --no-deps --user root -v "$PWD/backups:/backup" relay sh -c 'tar czf /backup/relay-backup.tar.gz -C /app/data .'
docker compose start relay
```

恢复到**空数据卷**：

```sh
docker compose stop relay
docker compose run --rm --no-deps --user root -v "$PWD/backups:/backup:ro" relay sh -c 'tar xzf /backup/relay-backup.tar.gz -C /app/data && chown -R node:node /app/data'
docker compose start relay
```

恢复前先保留当前卷；不要直接覆盖非空目录。恢复后启动清理器会删除已经过期的文件。备份副本不属于在线清理范围，需自行设置备份保留周期。

升级时先备份，再拉取新源码并运行 `docker compose up -d --build`。新数据目录使用 SQLite schema v2。已有的 v1 库会在打开时补上账号停用标记、会话创建时间和活动记录，然后升到 v2。更晚的版本会拒绝启动。

## API 简表

除配置、健康、注册和登录外，其余接口需同源会话 Cookie。除 GET、HEAD、OPTIONS 外都校验请求来源。接口返回 JSON，错误格式为 `{ "error": "中文说明" }`。代理返回的 HTML、413 和 429 会在界面上显示可读说明。

| 方法与路径                                                | 用途                                                                                                             |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `GET /api/health`、`GET /api/config`                      | 健康与客户端限制配置                                                                                             |
| `POST /api/auth/register`、`POST /api/auth/login`         | `{ username, password }`。注册按 IP 和用户名限流，登录按 IP 和用户名限流。停用账号在密码正确时返回 403           |
| `GET /api/auth/me`、`POST /api/auth/logout`               | 当前账号与退出                                                                                                   |
| `POST /api/auth/password`                                 | `{ currentPassword, newPassword }`，保留当前会话                                                                 |
| `GET /api/auth/sessions`、`DELETE /api/auth/sessions/:id` | 会话列表；删除当前会话会清掉 Cookie                                                                              |
| `GET /api/rooms`、`POST /api/rooms`                       | 已加入房间、使用 `{ name }` 创建                                                                                 |
| `POST /api/rooms/join`                                    | 使用 `{ code }` 加入，重复加入不重复创建成员                                                                     |
| `GET /api/rooms/:id`、`GET /api/rooms/:id/members`        | 房间状态与成员。非管理员的房间对象不含 `code`                                                                    |
| `PATCH /api/rooms/:id`                                    | 管理员修改 `{ ttlHours: 1\|24\|168\|720 }`                                                                       |
| `POST /api/rooms/:id/reset-code`                          | 管理员重置配对码                                                                                                 |
| `DELETE /api/rooms/:id/members/:userId`                   | 管理员移出其他成员                                                                                               |
| `POST /api/rooms/:id/leave`                               | 非管理员离开房间                                                                                                 |
| `GET /api/rooms/:id/audit`                                | 管理员查看最近 50 条活动                                                                                         |
| `GET /api/rooms/:id/files`                                | `tab=received\|sent&search=文件名&page=1`，每页 50 条。管理员可见定向文件名，字段 `restricted` 为真时没有接收人  |
| `POST /api/rooms/:id/files`                               | `multipart/form-data` 单文件字段 `file`；查询参数 `audience=all` 或 `audience=selected&recipients=用户ID,用户ID` |
| `GET /api/files/:id/download`                             | 鉴权下载，支持 HEAD 与 HTTP Range。非接收人即使是管理员也返回 404                                                |
| `DELETE /api/files/:id`                                   | 发送者或房间管理员可删除。看不见该文件的成员返回 404，看得见但不是发送者也不是管理员时返回 403                   |

客户端通过每 5 秒轮询更新当前房间、成员、文件；页面隐藏时暂停，重新可见立即更新。下载采用浏览器原生流式下载，不将大文件加载到 JS Blob 中。上传有效期在每个文件完成入库时确定，因此批量上传期间管理员修改设置，之后完成的文件采用新设置。

## 开发验证

```sh
npm test
npm run lint
npm run format:check
npm run build
npx playwright install chromium
npm run test:ui
```

`npm test` 使用独立临时目录、独立 HTTP 服务和可控时钟，覆盖账号会话、跨设备恢复、权限隔离、新成员历史文件、配对码、到期处理、重启持久化、大小和并发容量限制、上传中断、中文与同名文件、密码重置、成员治理、旧库迁移和依赖版本。浏览器冒烟测试不在这个命令里，需要先构建前端并安装 Playwright 的 Chromium。

技术结构：`src/` 为 React 界面；`server/` 为 Express、SQLite、上传与清理；`tests/` 为 Node 测试。密码使用 scrypt，新哈希记着计算成本；更早的哈希仍可登录。无外部字体、CDN 或运行时第三方服务依赖。
