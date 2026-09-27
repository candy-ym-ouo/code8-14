# 纸质书阅读痕迹

一个记录纸质书中折角、批注、重读页和读完情绪的长期个人档案。

项目刻意不记录阅读时长、阅读速度、阅读进度百分比、连续打卡或排行榜。页码只用于定位阅读痕迹，不参与速度计算。

## 技术栈

- 前端：Vue 3、TypeScript、Vite、Vue Router、Pinia、Zod
- 后端：Node.js 20+、TypeScript、Fastify、Prisma
- 数据库：PostgreSQL 16
- 测试：Vitest、Playwright

## 目录

```text
origin/
├─ apps/
│  ├─ api/                 Fastify API、Prisma 模型与迁移
│  └─ web/                 Vue 3 单页应用
├─ packages/shared/        前后端共享枚举与契约类型
├─ e2e/                    Playwright 端到端测试
└─ .env.example
```

## 本地运行

要求：

- Node.js 20 以上
- npm 10 以上
- PostgreSQL 16

先创建本地数据库和账号。以下命令以默认配置为例；如果使用已有 PostgreSQL，请直接修改 `DATABASE_URL`。

```bash
psql postgres -c "CREATE ROLE app LOGIN PASSWORD 'app';"
psql postgres -c "CREATE DATABASE paper_book_traces OWNER app;"
```

安装并启动：

```bash
cd origin
cp .env.example .env
npm install
npm run db:generate
npm run db:migrate
npm run db:seed
npm run dev
```

访问：

- Web：<http://localhost:5173>
- API 健康检查：<http://localhost:3000/health/ready>

`db:seed` 只检查数据库连接，不创建 demo 账号或演示内容。所有业务数据都从真实注册和操作产生。

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `DATABASE_URL` | PostgreSQL 连接字符串 |
| `SESSION_SECRET` | 会话 Cookie 签名密钥，至少 32 个字符 |
| `SESSION_TTL_DAYS` | 会话空闲有效期，默认 30 天 |
| `COOKIE_SECURE` | HTTPS 生产环境必须为 `true` |
| `WEB_ORIGIN` | 允许的前端来源，默认 `http://localhost:5173` |
| `EXPORT_MAX_ROWS` | 单次 JSON 导出的总行数上限 |
| `VITE_API_BASE_URL` | 前端 API 基础路径，默认 `/api/v1` |

不要把生产 `.env` 提交到 Git，也不要使用示例 `SESSION_SECRET` 部署。

## 已验证的业务闭环

1. 注册并建立真实用户会话；
2. 新建纸质书；
3. 将书从“想读”切换到“阅读中”；
4. 记录折角，同页不同原因被 `409` 拒绝；
5. 创建单页或跨页批注；
6. 同一页记录多次重读；
7. 标记读完并保存 1 至 3 个情绪标签与文字；
8. 在书目详情和全局时间线回看变化；
9. 导出不含密码和会话信息的 JSON 档案；
10. 删除痕迹后 24 小时内可撤销；
11. 痕迹每次变更追加差异快照，可按时间回滚，历史版本随时复算。

## 痕迹版本快照与回滚

折角、批注、重读页的每次创建、修改、删除、恢复（含删书级联）都会在同一事务中追加一条 `TraceSnapshot`：

- 快照只存与上一版本的**差异**（首版本存全量），同一痕迹的快照按实体 `version` 构成连续链条；
- 每条快照带 `stateHash`（全量状态的 SHA-256），任意历史版本都能从链首逐条复算并校验，篡改或断链会被拒绝；
- 回滚不改写历史：按 `targetTime` 定位当时的快照、复算出状态后，作为**新版本**追加到链尾，并写入 `ROLLED_BACK` 事件，事件序列只增不减；
- 回滚必须携带当前 `version` 做乐观并发校验，行锁（`SELECT ... FOR UPDATE`）保证并发回滚只有一个成功，其余收到 `409 STALE_WRITE`；
- 功能上线前已存在的痕迹，在首次变更时自动补一条全量基线快照，基线之前的时间不可回滚。

接口：

- `GET /api/v1/traces/:entityType/:entityId/snapshots` — 快照链（`entityType` 为 `DOG_EAR` / `ANNOTATION` / `REREAD_MARK`）；
- `GET /api/v1/traces/:entityType/:entityId/snapshots/:version/state` — 复算指定版本的全量状态并校验哈希；
- `POST /api/v1/traces/:entityType/:entityId/rollback` — 按时间回滚，请求体 `{ "targetTime": "<ISO 时间>", "version": <当前版本号> }`。

## 数据一致性

- 所有写操作通过 Prisma 事务完成。
- 业务对象、`ActivityEvent` 与 `TraceSnapshot` 在同一事务中提交。
- 删除采用软删除，删除历史不回抹时间线。
- 折角使用 PostgreSQL 部分唯一索引，只约束未删除记录。
- 完成感受使用 `completion_round` 区分多次读完整本书。
- 书目和痕迹使用 `version` 防止多端写入覆盖；回滚接口同样以 `version` 做并发校验。
- 痕迹快照链与实体版本一一对应：实体每递增一次版本，必须恰好追加一条快照。
- 所有查询强制带 `userId` 条件，越权资源统一返回 404。

## 常用命令

```bash
npm run dev
npm run lint
npm run typecheck
npm run test
npm run test:e2e
npm run build
npm run db:migrate
npm run db:migrate:dev
```

生产构建：

```bash
npm run build
```

构建后的前端位于 `apps/web/dist`，后端位于 `apps/api/dist`。生产环境需要独立启动 PostgreSQL、API 和静态文件服务，并通过 `WEB_ORIGIN` 与 `VITE_API_BASE_URL` 配置实际访问地址。

## 测试

单元与组件测试：

```bash
npm test
```

端到端测试需要 PostgreSQL、API 和 Web 已可运行：

```bash
npm run db:migrate
npm run test:e2e
```

Playwright 会启动 API 和 Web，并使用 Chromium 执行“注册 -> 建书 -> 折角”流程。若本机 `5173` 端口被占用，请先释放该端口或修改 Vite 与 `WEB_ORIGIN` 配置。

## 数据库迁移

开发时修改 `apps/api/prisma/schema.prisma` 后：

```bash
npm run db:migrate:dev -- --name change_name
npm run db:generate
```

部署时只执行已提交的迁移：

```bash
npm run db:migrate
```

生产发布顺序：

1. 备份数据库；
2. 执行 `npm run db:migrate`；
3. 启动新 API；
4. 等待 `/health/ready` 返回 200；
5. 发布前端静态资源。

## 备份与恢复

备份：

```bash
pg_dump -U app -d paper_book_traces -Fc > paper_book_traces.dump
```

恢复前先停止 API 写请求：

```bash
pg_restore -U app -d paper_book_traces --clean --if-exists paper_book_traces.dump
```

应用内的 JSON 导出用于个人留档，不替代数据库备份。

## 隐私边界

- 密码使用 Argon2id 哈希，数据库不保存明文。
- 会话令牌只保存 SHA-256 哈希。
- Cookie 使用 `HttpOnly` 和 `SameSite=Lax`。
- 生产环境必须设置 `COOKIE_SECURE=true` 并启用 HTTPS。
- 导出不包含密码哈希、会话令牌或内部认证字段。
- 用户文本按纯文本渲染，前端不使用 `v-html`。

## 产品约束

以下内容不属于本项目：

- 阅读时长、阅读速度和阅读进度；
- 连续阅读天数和排行；
- 社区、公开书评和推荐；
- AI 自动推断情绪；
- 电子书同步。

新增功能若引入上述量化指标，应视为破坏产品定位，而不是普通功能扩展。
