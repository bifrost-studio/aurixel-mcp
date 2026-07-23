# BifrostAPI MCP 站 — 设计稿

> v0.1 · 2026-07-01 · 状态:**设计阶段,未部署**(不碰服务器/DNS)
> 目的:给团队/老板对齐"要不要做、做到哪、怎么落"。

---

## 0. 一句话

一个**远程 MCP 端点**(`mcp.bifrostapi.net`),让 Claude Desktop / Cursor / Cline / ChatGPT 等 MCP 宿主**填一个 URL + 一把 `ck-` key** 就能调用 BifrostAPI 的工具(生图、音频、多模型问答),按**现有 Conduit 计费**,零后端改动。

**定位:获客渠道 + 存量增值,不是独立收入线。**

---

## 1. 为什么做 / 不做什么

- **MCP 变现的是"工具调用",不是推理。** 宿主自带 LLM,MCP 只提供工具。所以我们卖的是**便宜的生图 / 音频 / "从任何宿主访问我们 70 个模型"**,不是通用聊天(那是标准 API 的活)。
- **不做**:第三方 MCP 聚合市场(重、要托管别人代码、法务/运维风险高,超当前体量)。
- **现实预期**:利基附加 + 漏斗顶端。**成败在"能不能被发现(上架)",不在代码。** 现有 stdio 版就是死在没有发现路径(0 star / 0 收录,详见 `bifrostapi-mcp-usage-investigation` 记忆)。

---

## 2. 现状:地基已经有了

`http-server.js`(本仓,已实测):
- **远程 MCP**(Streamable HTTP 传输,现代宿主通用)
- **多租户**:逐请求读 `Authorization: Bearer ck-…`,**不存 key**
- **租户隔离**:异步生图 job 绑 key 哈希,别人猜到 UUID 也取不走
- **端到端验证过**:`initialize → tools/list → generate_image → 真图 image/png 1MB`
- **复用 Conduit `/v1/*` + ck- 计费,零 Conduit / cpagw 改动**

所以本设计不是从零,是把这个 MVP **补全工具 + 埋点 + 上架**。

---

## 3. 架构

```
MCP 宿主 (Claude Desktop / Cursor / Cline / ChatGPT …)
   │   一个 URL + ck- key(逐请求带 header)
   ▼
mcp.bifrostapi.net  ── Node / Streamable HTTP(本仓 http-server.js)
   │   把 MCP tools/call  →  翻译成我们的 REST /v1/*
   ▼
api.bifrostapi.net  ── Conduit:鉴权 ck-→user + 计费 + 余额
   ▼
cpagw → cli-proxy → 上游(Codex / packyapi / antigravity / DashScope …)
```

MCP 站本质是个**薄翻译层**:MCP 协议 ⇄ 我们已有的 OpenAI/Anthropic 兼容 REST。**不存 key、不碰 Conduit/cpagw**,blast-radius 完全隔离。

---

## 4. 工具集

| 工具 | 后端端点 | 说明 | 状态 |
|---|---|---|---|
| `generate_image` / `get_image_result` / `list_image_models` | `/v1/images/generations` | 异步 job+poll,绕开宿主 60s 超时;gpt-image-2 / gemini-image | ✅ 已实现 |
| `text_to_speech` | `/v1/audio/speech` | qwen-tts,返回音频 | 🟢 加(同模式) |
| `transcribe_audio` | `/v1/audio/transcriptions` | STT(deepgram / speechmatics) | 🟢 加 |
| `ask_model(model, prompt)` / `list_models` | `/v1/chat/completions` | **从任何宿主调我们 70 个模型**拿第二意见 / 便宜模型跑子任务 | 🟡 待定(见下) |
| `edit_image` / `voice_clone` | `/v1/images/edits` 等 | 后续扩展 | ⏳ v3 |

**`ask_model` 是最强也最需要拍板的卖点**:它把"用 MCP 卖推理"变成可能——一个 MCP = 从 Cursor/Claude Desktop 里访问我们全部模型。注意 **Claude 通道被 packyapi 污染**(见 `claude-channel-injection-pollution`),所以 `ask_claude` 一期先映射到 `gpt-5.5`,等换源再放真 Claude。

---

## 5. 鉴权(兼容性现实)

| 宿主 | bearer ck- (v1) | 需要 OAuth 2.1 (v2) |
|---|---|---|
| Cursor / Cline / Roo / VS Code / 自建 | ✅ 直接支持 header | — |
| Claude Desktop(本地 `mcp-remote` 桥) | ✅ 可带 header | — |
| **Claude.ai 网页自定义连接器** | ❌ | ✅ |
| **ChatGPT connectors** | ❌ | ✅ |

- **v1 = bearer ck-**:立刻覆盖开发者工具生态(Cursor/Cline 那批,正好是我们主力人群)。
- **v2 = OAuth 2.1(带动态注册)**:才能吃下 Claude.ai 网页版 + ChatGPT 两个消费级大入口。

---

## 6. 计费

- 每次 tool call = 一次 `/v1/*` 调用 = **Conduit 按 ck- 正常计费**(token / header_cost)。**零新计费逻辑。**
- 用户在 `www.bifrostapi.net/app/keys` 生成一把 ck-,填进 MCP 配置即可。

---

## 7. 可衡量(必须做,吸取教训)

现有 stdio 版**完全测不到用量**(usage_logs 无来源标记,详见 `bifrostapi-mcp-usage-investigation`)。v1 就埋:
- MCP 站转发时带**固定 UA `bifrostapi-mcp/<ver>`**,和/或引导用户用**命名 key**(`name=mcp-*`)。
- 这样能在 usage_logs / userstats 里**按来源量出 MCP 调用**,两周后**用数据判去留**,而不是"做了但不知道有没有人用"。

---

## 8. 部署计划(**暂不执行**)

- 独立 Node 服务(`http-server.js`)→ `systemd` → Caddy 反代 → `mcp.bifrostapi.net`(测试)/ `mcp.bifrostapi.net`(正式)。
- **前置条件**:① 服务器装 **node 运行时**(cpa/vision 现在只有 Go+Python);② **子域名 DNS** 指向服务器 + Caddy 自动签 TLS。
- **节奏**:测试线跑通 → 用真客户端(Cursor / Claude Desktop)连一遍 → 正式线。

---

## 9. 发现 / 上架(真正带量的一步,需批准)

- **上架清单**:Smithery、PulseMCP、`mcp.so`、Anthropic 连接器目录、awesome-mcp、Cursor/Cline 社区。
- **站内**:`/app/integrations` 加一张「MCP(远程)」卡 + 一页 landing。
- ⚠️ 属于**对外发布**,需你批准 + 我先备内容。

---

## 10. 安全 / 运维

- **不存 key**(逐请求);租户隔离(job 绑 key 哈希,已做)。
- 待补:**速率限**、内存上限、session 清理(sweeper 已有基础)。
- 图像 URL 取回走我们自己网关(低 SSRF 风险)。

---

## 11. 工作量估算

| 阶段 | 内容 | 估时 |
|---|---|---|
| v1 | 补音频 / (可选)ask_model 工具 + 来源打标 + 部署测试线 + 自测 | ~1–2 天 |
| v2 | OAuth 2.1 + 上架 Smithery/PulseMCP/Anthropic 目录 + landing | ~2–3 天 |
| v3 | 更多工具(edit_image / voice_clone),按数据决定是否深投 | 按需 |

---

## 12. 需要拍板的决策

1. **`ask_model` 进不进 v1?**(卖点最强,但要定"暴露哪些模型 / Claude 污染怎么规避 / 定价")
2. **OAuth v2 做不做?**(决定能不能吃 Claude.ai + ChatGPT 两个大入口)
3. **部署走不走?**(要装 node + 子域名 DNS)
4. **上架平台清单 + 谁去发?**

---

## 13. 路线图

- **v1(验证)**:工具补全(音频 + 可选 ask_model)+ 来源打标 → 部署测试线 → 真客户端自测。目标=**先能被衡量**。
- **v2(获客)**:OAuth → 上架 Smithery/PulseMCP/Anthropic 目录 → 站内 landing。目标=**造出发现路径**。
- **v3(深投)**:按 v1/v2 的真实数据决定加工具 / 加 OAuth 入口 / 还是收手。

> 相关记忆:`bifrostapi-mcp-usage-investigation`(现状 ≈0)、`claude-channel-injection-pollution`(ask_claude 为何暂用 gpt)、`prod-ai-api-cpa-stack`(栈)、`gateway-anthropic-claude-code`(各工具接入现实)。
