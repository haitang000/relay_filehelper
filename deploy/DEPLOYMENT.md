# 面板部署

轻传可以不使用 Docker，直接由面板里的 Node.js 项目运行。下面用占位路径和域名说明步骤，部署时换成自己的目录和域名。不要把应用端口对公网放行。

- 访问地址：`https://files.example.com`，由反向代理转到本机回环地址。
- 运行时：Node.js 24.x，使用面板提供的非登录运行用户。
- 应用目录示例：`/opt/relay`。
- 启动命令：`node /opt/relay/start.mjs`。
- 监听地址：`127.0.0.1:3080`。只允许反向代理访问这个端口。
- 数据目录：应用目录下的 `data`，包含 SQLite、上传文件、临时文件和进程锁。
- 示例容量：单文件 1 GiB、每批 20 个、每账号同时上传 2 个、同时下载 2 个、每房间 2 GiB、全站 8 GiB。这些数字只是示例，按磁盘调整。
- 示例配置关闭公开注册。第一个账号用管理命令创建，不要把密码写进命令行参数。
- `PUBLIC_ORIGIN` 填用户实际打开的地址，`COOKIE_SECURE=true`。`TRUST_PROXY=1` 表示前面恰好有一层可信代理，并且后端不能被绕过。

```sh
cp .env.example .env
# 编辑 PUBLIC_ORIGIN、配额和注册开关
printf '%s' '至少十位的密码' | node server/admin.mjs create-user alice
```

面板里可通过项目设置重启，通过项目日志排查问题。健康检查访问 `http://127.0.0.1:3080/api/health`。

## 生成无需服务器编译的部署包

在开发机安装 Node.js 24 后执行：

```sh
npm ci
npm run package:server
```

输出 `.deployment/relay-server.tar.gz`。压缩包包含编译好的前端、服务端、精简运行依赖、启动入口和 `.env.example`，不包含账号、上传数据或现成的 `.env`。`release.json` 记录源码、构建资源和示例配置的 SHA-256。

新服务器安装 Node.js 24 后，把包解压到应用目录，复制 `.env.example` 为 `.env` 并填写 `PUBLIC_ORIGIN`。若缺少 `.env`，`start.mjs` 会直接退出并提示。部署包已含 `node_modules`，不需要在服务器上编译前端或在线安装依赖。

## 更新与数据保留

只更新界面时，运行 `npm run package:web`，上传 `.deployment/relay-web.tar.gz` 并解压到应用目录。包内只有 `dist`，不含 `.env` 或 `data`。先写入带内容哈希的资源，最后替换首页入口，已打开的页面仍可使用旧资源，无需重启。发布后刷新浏览器。

更新程序前先停止进程，并备份整个应用目录。把新包里的 `server`、`dist`、`node_modules`、`start.mjs`、两个 package 文件、`.env.example` 和 `release.json` 换进应用目录。保留服务器现有 `.env` 和整个 `data`，不要用示例配置覆盖生产配置。再启动并检查 `/api/health`。

同一数据目录只能有一个轻传进程。第二个进程会因为 `relay.lock` 拒绝启动。密码重置和管理命令不占用这把锁，可以在服务运行时执行；命令行删除文件后，运行中的用量统计会在下一分钟按数据库校正。

备份账号和文件时，停止项目后备份整个 `data`，同时保管 `.env`。恢复时使用完整的数据目录。过期文件会在监听启动后分批补清理，每批最多 100 条。

数据库目前是 schema v2。v1 数据目录会在打开时补上停用标记、会话创建时间和活动记录，并升到 v2。比 v2 更新的库会拒绝启动，避免用旧程序写坏新库。
