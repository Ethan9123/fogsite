# FOGSITE · 雾境遗迹

非官方桌游数字改编，支持本地轮流操作及在线房间。游戏规则集中在 `src/game.js`，在线客户端只能收到各自角色的投影视图。

## 开发与检查

使用 Node.js 22.12 或更新的受支持版本。

```sh
npm ci
npm test
npm run build:client
npm run dev
```

`npm run dev` 在 http://localhost:5174 启动 Node HTTP/WebSocket 服务，可用四个独立标签页测试一名遗迹役和三名探索者。重连凭据保存在各标签页的 sessionStorage 中，刷新恢复原座位。关闭标签页可能丢失其凭据。

`node server.mjs` 仅提供 http://localhost:5173 静态预览，不提供在线房间 API。两个本地服务器都只发布客户端资源，不提供仓库元数据、环境文件或服务端脚本。

## Cloudflare Worker

```sh
npm run dev:worker
npx wrangler deploy --dry-run --outdir dist-worker
npm run deploy
```

Wrangler 的自定义构建步骤会先生成 `public/`，即使直接运行 `wrangler deploy` 也不会使用旧静态文件。真正部署需要你已有的 Cloudflare 账号权限；dry-run 不会部署。

每个房间使用一个 SQLite Durable Object 和 WebSocket Hibernation，角色状态和重连座位持久化。遗迹役与探索者共享同一套规则核心；60 秒逃脱倒计时由服务端定时器/持久化 alarm 控制，客户端不能提前触发超时。

默认仅接受与请求 URL 完全同源的创建房间和 WebSocket 请求。`ALLOWED_ORIGINS` 为空表示同源，不表示允许所有来源。若确实需要额外受信来源，可设置完整、以逗号分隔的 http(s) origin；显式列表会替代同源默认值，不能含路径、末尾斜杠或通配符，格式错误会拒绝访问。非浏览器测试客户端也必须显式发送正确 Origin。

## 发布前验收

- 当前提交的完整测试、客户端构建及 Worker dry-run 通过。
- 在真实 workerd 或 Cloudflare 运行时检查四客户端加入、角色视图隔离、断线重连、旧连接失效、畸形消息和服务端倒计时。
- 浏览器检查本地模式与在线模式、未占座/晚加入、返回菜单、重复操作和刷新恢复。
- 构建成功不是线上验收；发布后核对站点资源与发布提交。测试只使用合成房间，不读取其他人的房间。

测试中的 Durable Object 存储/Socket 模拟覆盖回归，但不能替代真实运行时验收。普通 Windows 账号如果不能创建符号链接，完整测试会明确跳过这一条权限相关用例，其余静态资源边界测试仍会执行。
