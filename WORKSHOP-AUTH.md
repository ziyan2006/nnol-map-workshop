# 工坊账号接口对接

本机原型使用四个预设演示身份。登录页提供两个玩家选项和两个审核选项，可在不同浏览器会话中演示工单认领。

## 接入边界

- `workshop_auth.py` 中的 `Identity` 是工坊接受的身份结构。用页游侧稳定、不可变的账号 ID 填 `id`，用可展示昵称填 `name`。角色从游戏团队的可信授权结果映射到 `player` 或 `developer`。
- `WorkshopHandler.login()` 调用 `server.identity_provider.authenticate(data)` 获取身份。使用由团队提供的登录验证接口时，在这一层替换 `DemoIdentityProvider`。若团队提供统一登录回调，则由回调完成验证，再用已验证的 `Identity` 调用 `Sessions.issue()`。登录页同时替换为实际登录入口。
- `Sessions.issue()` 保存随机会话令牌的摘要和过期时间。`Sessions.resolve()` 从会话取得账号和角色。`session_cookie()` 发出本机会话 Cookie。接入 HTTPS 部署时，在正式登录入口设定 `Secure`，并由团队决定账号停用、角色变更和会话撤销的同步方式。
- 工坊后端从会话写入投稿的 `owner_id` 和审核的 `reviewer_id`。ZIP 中的作者字段保留其素材来源用途。历史投稿保留原数据和审核记录，归属为空，供审核端查询。

## 路由与权限

| 路由 | 行为 |
| --- | --- |
| `/workshop/login` | 登录后玩家进入投稿页，开发者进入审核工单。 |
| `/workshop/` 与 `/workshop/account` | 玩家上传交付包并查看自己的进度。 |
| `/workshop/review` | 开发者查看全站工单并记录审核决定。 |
| `GET /api/workshop/session` | 返回当前会话身份。 |
| `GET /api/workshop/my-submissions` | 只返回当前玩家自己的投稿。 |
| `GET /api/workshop/packages` | 开发者的全站审核队列。 |
| `POST /api/workshop/packages` | 玩家上传交付包。按账号与 ZIP 摘要去重。 |
| `GET /api/workshop/packages/<id>/…` | 投稿详情、附件、下载和候选模型。投稿者和开发者可访问。 |
| `GET /api/workshop/packages/<id>/ticket` | 以工单任意一版的编号查当前版。 |
| `POST /api/workshop/packages/<id>/revision` | 投稿者为自己最新的退修版本补交 ZIP，要求同一地图目标。 |
| `POST /api/workshop/packages/<id>/claim`、`/release` | 已初审的工单可由审核员认领，当前认领人可释放。 |
| `POST /api/workshop/packages/<id>/decision` | 工单认领者记录正式决定。 |
| `POST /api/workshop/packages/<id>/complete` | 开发者为已接受的当前版本记录移植完成，可附说明。 |
| `POST /api/workshop/packages/<id>/withdraw` | 投稿者撤回自己当前的审核中、退修或待移植工单，可附说明。 |
| `POST /api/workshop/packages/<id>/block-porting`、`/unblock-porting` | 开发者登记待移植工单的公开阻塞原因，或解除阻塞。 |

正式对接需要游戏团队提供可验证的身份凭据或登录回调、稳定账号 ID，以及审核权限的来源。替换演示登录入口后，投稿归属和工单权限仍使用同一个 `Identity` 接口。
