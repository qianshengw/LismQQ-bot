# LismQQ-bot 技术文档

> 本文是 **LismQQ-bot 整个项目**的详细技术文档：设计动机、总体架构、每个模块的职责与关键机制、数据流、仿真系统、记忆、安全、配置、部署与测试。
>
> 面向：需要改代码、排查线上问题、理解内部机制的开发者。
> 代码基线：`src/` 下全部模块、`public/console.html`、`config.example.jsonc`。
> 文中 `file:line` 均指向当前仓库代码；旧文档与代码不一致处已在第 16 节列出。

---

## 1. 项目定位与设计动机

### 1.1 它是什么

LismQQ-bot 是一个 **NapCat（OneBot v11）↔ pi-agent-core** 的进程内桥接器：

```
QQ 消息 → NapCat（OneBot v11） → LismQQ-bot（Node 单进程）
                                   ├─ pi-agent-core  Agent 循环
                                   ├─ pi-ai          模型 provider
                                   ├─ pi-mcp         QQ 工具（stdio MCP）
                                   ├─ memory-pool    长期记忆
                                   └─ state/         会话与状态持久化
                                 → 模型 API（OpenAI 兼容）
```

### 1.2 为什么不用 harness / DSH

原版 `qq-bridge` 是 harness 的扩展，依赖 DSH 的 RPC 客户端（`dsh-client.js`，978 行 RPC + Cookie 鉴权 + remote.mux）。harness 在 ARM64、低内存设备上装不起来，于是本项目把这一层替换掉：

| 原 DSH 机制 | 本实现的替代 |
|---|---|
| `dsh-client.js`（RPC + Cookie + remote.mux） | `pi-host.js`：进程内直调 `Agent.prompt()`，事件经 `agent.subscribe()` 获得 |
| `session/create` + `state/sessions.json` 映射 | `Map<qqKey, SessionAgent>` + transcript 存 `state/sessions/<key>.json`，重启恢复 |
| `session/follow` 事件流 + turn 聚合 | `agent_start/turn_start/.../agent_end` 事件重映射为桥接回调 |
| Remote Event（提问/审批） | `beforeToolCall` 钩子：发送类工具转白名单复核后放行/拦截 |
| tokenUsage 投影 | `turn_end` 事件的 `message.usage` 累计 |
| MemoryProtocol / SharedMemoryPool（LightphpAgent 移植） | `memory-pool.js`：CJK bigram + 停用词 + token 重叠打分 + FIFO |
| MCP server（cordis 挂载） | `pi-mcp` 的 `StdioTransport` 直接 spawn 本仓库的 `src/mcp/*.mjs` |

### 1.3 运行环境

- Node.js ≥ 22.19（需要全局 `WebSocket`）
- 目标：Linux ARM64（已在 512M/4G 的 4G 随身 WiFi 棒上实测）
- 依赖：`@earendil-works/pi-agent-core` / `pi-ai` / `pi-mcp` 1.3.0 + `typebox`，无 native 依赖

---

## 2. 总体架构

```
QQ 客户端
  ↕ NapCat（OneBot v11 正向 WS + HTTP）
┌──────────────────────────────────────────────────────────────┐
│ ① 协议层  src/onebot.js        OneBotClient（WS + HTTP）      │
│ ② 调度层  src/bridge.js        Bridge（总控，入站/唤醒/发送）  │
│ ③ 计时层  src/wake-scheduler.js 唤醒/巡逻/睡眠/限频/防呆       │
│ ④ 引擎层  src/pi-host.js       SessionAgent / SessionManager   │
│ ⑤ 手脚层  src/mcp/*.mjs        QQ 工具 + web 工具（MCP stdio） │
└──────────────────────────────────────────────────────────────┘
持久化：state/ 下 social-v2.json / social-v1.json / sessions/*.json /
        memory.json / token-ledger.json(+.jsonl) / internal-token / bridge.lock
Web：public/console.html（Alpine.js 3 本地化）+ public/alpine.js
```

会话 key 统一为 `g<群号>` / `p<QQ号>`（`social-v2.js:19-27` `canonicalKey`，兼容旧 `group:123` / `private:456`）。

---

## 3. 模块详解

### 3.1 `onebot.js` — 协议层

- `normalizeMessageSegments`（L9）：CQ 码字符串 ↔ segment 数组双向归一，防 `.find` 抛错、防 @ 被藏。
- `parseMessageSegments`（L35）：`{text, images}`；`at`→`[@qq]`、`face`→`[表情:id]`、`record`→`[语音]`、`forward`→`[合并转发]`。
- `OneBotClient`（L83）：正向 WS（Node 22 全局 `WebSocket`）+ 可选 HTTP API。
  - access token 走 `Authorization: Bearer`，构造器拒 headers 时兜底 query `access_token`（L138-150）。
  - 事件：`onPrivateMessage/onGroupMessage/onNotice/onOpen/onClose/onError/onSelfId`。
  - 看门狗（L353）：90s 无入站帧判假连接，主动断开重连。
  - `meta_event` 帧自报 `self_id`（L261-270）——最可靠的机器人身份来源。
  - `call()`（L281）优先 HTTP，否则 WS `echo` 请求。

### 3.2 `bridge.js` — 调度层

Bridge 类（L339）持有全部状态。关键子域：

| 子域 | 位置 | 说明 |
|---|---|---|
| 配置加载 | `loadConfig` L82 | JSONC 剥整行注释；收敛越界值 |
| 系统提示词 | `loadSystemPrompt` L114 | persona + `chatBehaviorRules()` |
| 会话准入 | `isAllowed` L145 / `_sessionSendable` L3198 | deny 优先 |
| token 账本 | `TokenLedger` L157 | 峰谷价目折算 + JSONL 明细 + 走势桶 |
| 单实例锁 | `acquireInstanceLock` L281 | PID 存活检测 + 崩溃自愈 |
| 生命周期 | `start` L460 / `stop` L541 | 接线 bot、建 SessionManager、起内部 HTTP、恢复定时器 |
| 入站 | `handleIncoming` L611 | 白名单 → 未读入库 → 触发评估 |
| 媒体补齐 | `_enrichMessage` L839 | 引用回查 / 转发展开 / 图片 base64 |
| 唤醒链 | `_deliverWakePrompt` L989 / `_runWakeTurn` L1252 | 见第 9 节 |
| 发送 | `sendToQQ` L1797 / `_sendToSession` L3214 | 出站闸门 + 限频 |
| 工具构建 | `_buildTools` L1830 / `_initializeTools` L1842 | spawn MCP server |
| 内部 HTTP | `_startInternalHttp` L1885 / `_handleInternal` L2001 | 工具回调 + 控制台 |

### 3.3 `pi-host.js` — 引擎层

- `resolveModel`（L32）：内置 deepseek 目录优先；有 `baseUrl` 则注册自定义 OpenAI 兼容 provider。
- `SessionAgent`（L172）：封装 pi `Agent`。
  - `_dispatch`（L262）把 pi 事件映射为桥接回调：`onTextDelta/onToolCall/onToolResult/onAssistantMessage/onTurnUsage/onRunComplete`。
  - `_injectMemory`（L316）：`transformContext` 钩子，只读 `scope='user'`，注入 `##用户偏好` 块。
  - `_sanitizeTranscript`（L472）：清孤儿 toolResult / 无结果 toolCall。
  - `_trimHistoryAsync`（L355）：超 `maxMessages` 时切点前移 + 摘要压缩（失败降级硬丢）。
  - `applyCurrentSystemMessage`（L132）：恢复 transcript 时强制替换 system，防旧人设盖新人设。
  - `prompt`（L521）：回合超时 abort + 自洁 + 裁剪。
- `SessionManager`（L590）：`qqKey → SessionAgent`，transcript 原子写持久化。
  - `reconfigure`（L746）：热切换模型/人设；忙碌会话标 pending，回合边界重建，不阻塞全局。
  - `applyRuntimeLimits`（L705）：运行参数热更新传播到所有已存在会话。

### 3.4 `social-v2.js` — 二代仿真状态仓库

- `DEFAULT_WAKE_CONFIG`（L36）/ `DEFAULT_V2_LIMITS`（L53）。
- `evaluateWakeTrigger`（L168）：按优先级评估一条消息是否命中触发器。
- `newConversationState`（L211）：每会话状态结构（未读 / 三水位 / 记忆 / 限频窗口）。
- `SocialV2Store`（L262）：
  - `pushIncoming`（L364）：分配 seq，入 unread + recentMessages。
  - `peekUnread`（L404）/ `markShownSeqs`（L425）/ `markRead`（L457）/ `markReadSeqs`（L475）/ `markHandled`（L490）。
  - `trackExplicitPending`（L509）/ `archiveStale`（L532）。
  - `appendMemory`（L554）/ `touchImpression`（L591）/ `formatMemory`（L657）。
  - `tryRegisterWake`（L699）：四档限频。
  - `reserveSendSlots`（L743）/ `releaseSendSlots`（L758）。

### 3.5 `wake-scheduler.js` — 计时层

- `WakeScheduler`（L13），时钟可注入（`now/setTimeout/clearTimeout`）便于假时钟测试。
- `onIncomingMessage`（L77）→ `evaluateWakeTrigger`。
- `scheduleWake`（L97）：合并窗口，同窗口多因按优先级取最高；`immediate=true` 直通。
- `tryWake`（L138）：忙时暂存（有界 20）→ 分档限频 → `onWake`。
- `setupSleepTimer`（L212）：100s 小步长续期。
- `scheduleProactiveCheck`（L234）：概率加权巡逻，无条件自排。
- `scheduleReplyCheck`（L272）：发言后 30s 回看。
- 防呆：`ensureWakeable`（L290）/ `noteNoAction`（L320）/ `noteAction`（L333）。

### 3.6 `social-v1.js` — 一代仿真状态机

- 四相：`idle / active / probing / exiting`（L176-189）。
- `SocialV1Store`（L191）：`enterActive/leaveActive/enterProbing/startExit/finishExit`。
- `shouldTriggerFromIdle`（L387）/ `shouldSkipInActive`（L396）/ `tick`（L414）。
- `[SILENT]` 判定（L96）/ 退场话正则（L106）/ 指向性判定（L150）。
- CJK 空格分条（L36）/ 超长硬切（L56）。

### 3.7 `memory-pool.js` — 长期记忆池

- `tokenize`（L28）：小写化、剥标点、停用词、CJK bigram。
- `SharedMemoryPool`（L68）：`store` / `retrieve`（token 重叠打分）/ `listRecords` / `clear` / `toJSON` / `fromJSON`。
- `renderPreferenceBlock`（L180）：渲染 `##用户偏好` 块。

### 3.8 `mcp/*` — 工具层

- `wrap.js`（L16）：把 MCP stdio server 工具包成 pi `AgentTool`。
- `qq-tools-server.mjs`（398 行）：14 个 QQ 工具。
  - 会话上下文用 `AsyncLocalStorage`（L27）+ 隐藏参数 `__qqSession`（L30）。
  - 同会话串行、跨会话并发（L366-377）。
  - 所有动作经内部 HTTP 回调桥接（`bridgeApi` L32）。
- `web-search-server.mjs`（200 行）：只读 `web_search` / `web_fetch`，SSRF 防护走 `safe-fetch.js`。

### 3.9 辅助模块

| 模块 | 职责 |
|---|---|
| `md-to-plain.js` | Markdown → QQ 纯文本、`splitForQQ` 分条、`normalizeChatSpacing` |
| `forward.js` | 合并转发展开、引用回查辅助、forward id 校验 |
| `media.js` | 图片抓取（≤1MiB，jpeg/png/webp/gif），逐跳 SSRF 校验 |
| `sensitive.js` | 出站脱敏双闸门（启发式 + 已知令牌精确名单） |
| `safe-fetch.js` | 只读 HTTP(S) 安全抓取（私网/环回/CGNAT/NAT64 全拒，DNS 反 rebinding） |
| `model-prices.js` | DeepSeek 峰谷价目表与金额折算 |
| `burst.js` | 连发条数/间隔规划 |
| `qq-chat-rules.js` | 系统级 QQ 会话行为规则 |

---

## 4. 数据流

### 4.1 入站：QQ 消息 → AI

```
OneBot 事件 → OneBotClient._handleFrame (onebot.js:219)
  → onPrivateMessage/onGroupMessage/onNotice(poke) (bridge.js:594-603)
  → Bridge.handleIncoming (bridge.js:611)
      1. 过滤自己发的 / message_sent
      2. isAllowed 白名单
      3. 解析发送者名 / 引用目标
      4. socialV2.pushIncoming（未读唯一事实源）
      5. wakeScheduler.onIncomingMessage（触发评估）
      6. 命中 → scheduleWake → tryWake → onWake
  → _deliverWakePrompt (bridge.js:989)（排队到每会话串行队列）
  → _runWakeTurn (bridge.js:1252)
      → 选批 → 建唤醒 prompt → agent.prompt()
      → 模型在回合内调用 MCP 工具
```

### 4.2 出站：AI → QQ

三条出口，全部过 `_guardOutbound`（`bridge.js:1240`）：

1. **首答即时外发**：`onAssistantMessage` → `_maybeSendImmediateAnswer`（`bridge.js:1435`）。
2. **兜底发送**：回合结束模型只吐文字没调工具时发出（`bridge.js:1351`）。
3. **发送工具**：`qq_send_message` / `qq_reply` / `qq_send_burst` → 内部 HTTP → `_sendToSession`。

`_sendToSession`（`bridge.js:3214`）是最后一道：SILENT/退场话复检 + 发送限频预占 + OneBot 调用。

### 4.3 工具回调

```
模型调工具 → pi-mcp → qq-tools-server（MCP stdio 子进程）
  → bridgeApi（x-qq-session + x-console-token + x-agent-call）
  → bridge /agent/* 端点
  → OneBotClient（发送/查询）
  → 结果沿原路返回模型
```

---

## 5. 会话与持久化

### 5.1 会话 key

`g<群号>` / `p<QQ号>`（`bridge.js:141-143` `sessionKeyOf`）。

### 5.2 transcript

- 每个会话一份 `state/sessions/<key>.json`（key 中非法字符替换为 `_`）。
- 原子写：`.tmp` → rename（`pi-host.js:717-727`）。
- 重启恢复：`_create` 读文件 → `applyCurrentSystemMessage` 替换 system → 注入 Agent。

### 5.3 状态文件

| 文件 | 内容 |
|---|---|
| `social-v2.json` | v2 会话状态（未读/三水位/唤醒配置/记忆/限频窗口） |
| `social-v1.json` | v1 相位状态机 |
| `sessions/*.json` | 各会话 transcript |
| `memory.json` | 长期记忆池 |
| `token-ledger.json` / `.jsonl` | 账本汇总 / 按轮明细 |
| `internal-token` | 内部回调令牌（自动生成） |
| `bridge.lock` | 单实例锁（`PID|时间戳`） |

---

## 6. 模型接入

`resolveModel`（`pi-host.js:32`）：

- `provider === 'deepseek'` → 内置目录。
- 有 `baseUrl` 且目录里没有该模型 → 注册自定义 OpenAI 兼容 provider。
- `baseUrl` 会去掉末尾 `/chat/completions`、`/v1` 等后缀。

`streamFn` 注入 `apiKey` / `maxTokens` / `timeoutMs`（`pi-host.js:231-241`）。

热切换：`POST /api/model`（`bridge.js:2514`）先验证新配置可加载，再落盘，再 `sessionManager.reconfigure`。

---

## 7. 上下文管理

| 机制 | 位置 | 说明 |
|---|---|---|
| transcript 自洁 | `_sanitizeTranscript` L472 | 清孤儿 toolResult / 无结果 toolCall，防持久 400 |
| 裁剪 + 摘要压缩 | `_trimHistoryAsync` L355 | 超 `maxMessages` 把旧区段压成 `summary:true` 消息；失败降级硬丢 |
| 切点前移 | L374-378 | 保留段开头不能是 toolResult，防 tool 配对断裂 |
| 人设热替换 | `applyCurrentSystemMessage` L132 | 恢复时强制用当前 systemPrompt |
| 回合超时 | `prompt` L529-531 | `maxTurnSeconds` 到点 abort |

---

## 8. 记忆系统

### 8.1 长期记忆池（`memory-pool.js`）

- CJK bigram：`乌龙茶` → `乌龙` / `龙茶`，中文子串可命中。
- 停用词 + 标点剥离。
- 分区：用户提问写 `scope='utterance'`，偏好注入只读 `scope='user'`。
- FIFO：超 `maxRecords` 淘汰最旧。
- 读侧 `transformContext` 注入 `##用户偏好`；写侧自动捕获 + 可选 `memory_write` 工具。

### 8.2 v2 群友记忆（`social-v2.js`）

| 分类 | 用途 | 过期 |
|---|---|---|
| `topic` | 近期话题 | 24h |
| `thought` | 想做的事（带 motivation） | 2h |
| `impression` | 群友印象（traits / 互动次数） | 无（按最久未见淘汰） |

---

## 9. 仿真系统

### 9.1 概念对齐：唤醒 vs 回合 vs 模型轮次

| 概念 | 定义 | 代码 |
|---|---|---|
| **唤醒（wake）** | 调度器事件：触发器或定时器命中 → `tryWake` → `onWake` | `wake-scheduler.js:138` |
| **桥接回合（turn）** | 一次 `agent.prompt()` 调用 = 一个 pi agent run | `bridge.js:1315` |
| **模型轮次（pi turn）** | 一次 LLM 请求-响应 + 该响应请求的工具执行 | pi-agent-core `agent-loop.js:180` |

- 一次唤醒默认 = 一次 `_runWakeTurn` = 一次 `agent.prompt()`。
- 一个桥接回合内可以跑多个模型轮次，由「模型是否继续调工具」决定（`agent-loop.js:156-190`）。
- 一次唤醒事件也可能派生多次桥接回合（续读/重试/回复检查），在同一会话队列上串行。
- `maxTurnSeconds` 约束的是整个 agent run，不是单个模型轮次。

### 9.2 v2 完整生命周期

#### 9.2.1 启动初始化（`bridge.js:460`）

1. 创建 `SocialV2Store`，恢复 JSON。
2. 创建 `WakeScheduler`，`onWake` 接 `_deliverWakePrompt`。
3. 对每个已存在会话：`setupSleepTimer` + `scheduleProactiveCheck`。
4. 60s 定期落盘。

#### 9.2.2 入站消息（`handleIncoming`，`bridge.js:611`）

```
过滤自己发的 / message_sent            bridge.js:612
isAllowed 白名单（deny 优先）          bridge.js:617
解析发送者名 / 引用目标                bridge.js:620-623
判定 atMe / questionToMe / isPoke      bridge.js:628-630
pushIncoming（分配 seq，入 unread）    bridge.js:641-652
_notifyWaiters（唤醒正在 wait 的回合） bridge.js:657
v2 触发分叉                            bridge.js:659-689
```

**分叉规则：**

- `mode === 'v2' && atMe` → **@ 直通**：`scheduleWake('atMention', {immediate:true, tier:direct})` 后直接 return（`bridge.js:674-675`）。
- 其余（含私聊）→ `touchImpression` → `archiveStale` → `onIncomingMessage` → `expireMemory`；`mode==='v2'` 时 return。

> 私聊没有 at 段，走 `evaluateWakeTrigger` 的 `isPrivate → private`，过合并窗口但档位是 `direct`。

#### 9.2.3 触发评估（`evaluateWakeTrigger`，`social-v2.js:168-207`）

| 顺序 | 条件 | reason | 档位 |
|---|---|---|---|
| 1 | `message.isPrivate` | `private` | direct |
| 2 | `atMention && atMe` | `atMention` | direct |
| 3 | `nameMention && 文本含 myName` | `nameMention` | normal |
| 4 | `question && questionToMe` | `question` | normal |
| 5 | `poke && isPoke` | `poke` | direct |
| 6 | `keywords` 命中（短英文词按词边界） | `keyword` | normal |
| 7 | `speakerIds` 含发送者 | `speaker` | normal |
| 8 | 我上一句是问句 + `followUpWindowMs` 内对方接话 | `followUp` | followUp |
| 9 | `anyMessage` | `anyMessage` | normal |
| 10 | `Math.random() < probability` | `probability` | normal |

`questionToMe` 由 `bridge.js:961-976` 判定：@我 / 引用的是我 / 有问号且提到我名字或指向性措辞 / 无问号但有接话引导词。

#### 9.2.4 唤醒调度

- `scheduleWake`（`wake-scheduler.js:97`）：非 immediate 起合并窗口定时器；immediate 直通。
- `_flushWakes`（L124）：取 `WAKE_PRIORITY` 最高的一条。
- `tryWake`（L138）：忙时暂存 → 分档限频 → `onWake`；超限压 pendingWakes + 起 wakeRetry 定时器。

#### 9.2.5 唤醒投递（`_deliverWakePrompt`，`bridge.js:989`）

排进每会话串行队列 `runtime.queue`：

```
守卫：running && socialV2 && mode==='v2'
重复唤醒跳过：用户触发类 reason 且 _selectWakeBatch().batch.length===0
await _runWakeTurn(key, reason)
```

#### 9.2.6 唤醒回合（`_runWakeTurn`，`bridge.js:1252`）

**准备：**

```
setBusy(key, true)
agent = await sessionManager.get(key)
清空 toolSentInTurn / turnSendReceipts
waitBudgetMs = 12 分钟
绑定 onTurnUsage / onAssistantMessage
```

**选批（`_selectWakeBatch`，L1178）：**

- 合并 `pendingExplicit` + `peekUnread`，按 seq 去重排序。
- ≤20 条全投；>20 且有显式请求从最新显式请求前 2 条开始取 20 条，更早作 background；>20 无显式请求取最近 20 条。

**构建 prompt（`_buildWakePrompt`，L1100）：**

```
【唤醒】/【唤醒原因】+ _buildReasonHint
【关于这个会话】initialPrompt（仅首次）
【纠错】pendingCorrection
【现在】时间观念
【你是谁】persona.name + myQQId
【节奏】近 1h 发言量
【未读消息】seq / 绝对时刻 / 相对年龄 / @标注
【你的记忆】topic / thought / impression
【重要】hasAtMe → 必须回应
（可做什么：send / send_burst / mark_read / set_wake_config）
【收尾流程】
```

**投喂：**

```
_enrichMessage（引用/转发/图片）
markShownSeqs（推进 shownSeq，不移除队列）
trackExplicitPending
turn = await agent.prompt(promptText, visionImages)
```

**回合结束判定（L1318-1402）：**

```
responded = _hasRealSend(key)
silentish = _guardOutbound(reply) 不通过

1) @ 违规：记违规 seq，同批未重试过则设 pendingCorrection + 立即重试（direct 档）
2) 兜底发送：出站闸门 → splitForQQ → 逐条发送
3) 自动 markRead：本批有回执或非 @ 场景
4) 出错：网络类错误且未发过 → 一次重试
5) 防呆：noteAction / noteNoAction / ensureWakeable
```

**finally（L1406）：**

```
解绑 onAssistantMessage
setBusy(key, false)（触发忙时补发）
save
分批续读：仍有未展示未读且非出错/非违规 → scheduleWake('unreadContinuation')
```

### 9.3 观察阶段（睡前观察）

**不是独立回合**，是同一 `agent.prompt()` 内的模型轮次。

调用链：`qq_wait_for_messages` → `POST /agent/wait` → `_waitForMessages`（`bridge.js:3261`）。

- 只等游标（`shownSeq`）之后的新消息。
- `timeoutSeconds` 1–600，默认 300；`quietMs` 0–60000，默认 8000。
- 每回合观察预算 12 分钟，按实际等待扣减；用完立即返回空。
- 观察到的消息 `markShownSeqs` + `trackExplicitPending`，带相对时间/指向标注返回。

**409 硬闸：**

本回合投喂过未读（`hadUnreadThisTurn=true`）且 `waitBudgetMs` 仍是满额时：

- `/agent/wake-config` 设 `diving` 或 `infinite=false` → 409。
- `/agent/mark-read` → 409。

豁免：`waitBudgetMs < 12min`（观察过一场即放行）；设 `active` 不拦。

### 9.4 收尾与休眠

休眠不是自动的，必须模型显式调 `qq_set_wake_config`。

`/agent/wake-config`（`bridge.js:2200`）：

```
409 观察硬闸
triggers 类型校验
sleepUntil → _clampSleepUntil（min/max + 4h 上限）
infinite=false 强制 mode=diving
atMention 硬钳：潜水时强制 true
batchWindowMs 1000-60000
save 失败 → 回滚
infinite=false → setupSleepTimer；否则 clearSleepTimer
```

`/agent/mark-read`（`bridge.js:2283`）：409 硬闸 → `markRead(seq)`（只清 shownSeqs 里的）→ noteAction。

### 9.5 定时器族

| 定时器 | 行为 | 代码 |
|---|---|---|
| 睡眠 | `infinite=false` 时按 `sleepUntil` 定时，100s 小步长续期；到点恢复 `infinite=true` + `tryWake('timeout')` | `wake-scheduler.js:212` |
| 巡逻 | 自排 `proactiveMinMs~proactiveMaxMs`；概率加权（想法×1.4 / 30min 内发过言×0.5 / 深夜×0.3 / 话痨×0.3）；无条件自排下一轮 | `wake-scheduler.js:234` |
| 回复检查 | 发送后 30s；基础 0.5，问句×1.5，burst×1.3，上限 0.95 | `wake-scheduler.js:272` |

### 9.6 防呆三件套

| 机制 | 行为 | 代码 |
|---|---|---|
| 无触发条件重置 | 回合结束发现没有任何触发器 → 重置默认 | `wake-scheduler.js:290` |
| 空醒计数 | 连续 3 次既没发消息也没 mark_read → 重置为 active | `wake-scheduler.js:320` |
| atMention 硬钳 | 潜水时强制 `atMention=true` | `bridge.js:2260` |

### 9.7 未读三水位

| 水位 | 谁推进 | 含义 |
|---|---|---|
| `shownSeq` | `markShownSeqs` | 模型看过什么 |
| `lastReadThroughSeq` | `markRead` / `markReadSeqs` | 模型确认已读 |
| `handledSeq` | `markHandled` | QQ 里确实回应了 |

读一次 ≠ 回应了。未读只有一份，首屏、`qq_get_unread_messages`、`qq_wait_for_messages` 读同一份。

- 展示只推进 `shownSeq`，不移除队列——回合失败可原样重投。
- 真正离开队列靠 `markRead` / `markReadSeqs` / `markHandled` / `archiveStale`。
- 显式请求永不归档；被容量挤掉时转存 `pendingExplicit`。

### 9.8 唤醒限频（四档）

| 档位 | 触发 | 默认额度 |
|---|---|---|
| `direct` | 私聊 / @我 / 戳一戳 | 6 次/分、120 次/时 |
| `followUp` | 我问过话、对方在窗口内接话 | 3 次/分、60 次/时 |
| `normal` | 提到名字 / 向我提问 / 关键词 / 指定人 / 任意消息 / 概率 | 1 次/分、30 次/时 |
| `proactive` | 巡逻 / 回复检查 / 睡眠到点 / 手动唤醒 / 分批续读 | 1 次/分、20 次/时 |

`direct` / `followUp` 有下限保护：不得低于 `normal` 档。

发送限频：`reserveSendSlots`（预占）+ `releaseSendSlots`（失败回滚）。

### 9.9 v1 四相状态机

```
idle（观望）   → active：明确点名 / 随机 triggerProbability
active（活跃） → exiting：活跃超时（15-30min 随机）
               → probing：冷场 6min + 25% 概率试探
               → idle：冷场 + 未中试探概率
probing（试探）→ active：窗口内有人说话；窗口过 → idle
exiting（退场）→ idle：退场话说完或 60min 兜底
```

驱动：`bridge.js` 每 5 秒 `_v1Tick`。AI 用 `[SILENT]` 潜水、用 CJK 空格分条。

> v2 `mode='v2'` 时 v1 零参与（`bridge.js:618`），设计如此。

---

## 10. 工具面

### 10.1 QQ 工具（14 个）

| 工具 | 功能 |
|---|---|
| `qq_get_unread_messages` | 读未读（可带 afterSeq/limit） |
| `qq_get_group_history` | 当前群历史（最多 50 条） |
| `qq_send_message` | 单发/数组 |
| `qq_reply` | 引用回复 |
| `qq_list_groups` | 群列表 |
| `qq_get_group_members` | 群成员 |
| `qq_get_message_images` | 未读图片 URL |
| `qq_get_forward_msg` | 展开合并转发 |
| `qq_set_wake_config` | 设唤醒配置（409 硬闸） |
| `qq_mark_read` | 确认已读（409 硬闸） |
| `qq_memory` | 记忆增删查清 |
| `qq_send_burst` | 连发 |
| `qq_wait_for_messages` | 观察等待（≤600s） |
| `qq_session_status` | 会话状态 |

### 10.2 Web 工具

- `web_search`：优先 OpenAI 兼容端点，失败回退 Bing RSS。
- `web_fetch`：只读公网 URL，SSRF 防护，正文 ≤512KB。

---

## 11. 安全

| 边界 | 实现 |
|---|---|
| 收侧白名单 | `isAllowed`（deny 优先）`bridge.js:145` |
| 发侧复核 | `_sessionSendable` `bridge.js:3198` + `beforeToolCall` `_approveToolCall` L1876 |
| 出站脱敏 | `redactAll`：启发式正则 + 已知令牌精确名单 |
| SSRF | `safe-fetch.js`：私网/环回/CGNAT/NAT64 全拒，DNS 全解析校验，逐跳重定向校验 |
| 内部 HTTP | `/agent/*` 需 `x-console-token` + `x-agent-call`；控制面仅 Origin-Host 校验 |
| 单实例锁 | `state/bridge.lock`，PID 存活检测 + 崩溃自愈 |
| 控制台 | 免 token，监听 `0.0.0.0` 时依赖局域网边界，勿映射公网 |

---

## 12. 控制台 API

| 端点 | 方法 | 作用 |
|---|---|---|
| `/status` | GET | 运行状态 |
| `/api/tokens/summary` / `series` | GET | 用量汇总 / 走势 |
| `/api/persona` | GET/POST | 人设读写 |
| `/api/whitelist` | GET/POST | 白名单 |
| `/api/model` | GET/POST | 模型查看 / 热切换 |
| `/api/runtime` | GET/POST | 运行参数 |
| `/api/simulation` | GET/POST | v1/v2 热开关 |
| `/api/socialv2/*` | GET/POST | 二代仿真（states/state/wake/config/initial-prompt/schedule/memory/reset） |
| `/api/socialv1/*` | GET/POST | 一代仿真（states/config/activity/state/flush） |
| `/memory` | GET/DELETE | 记忆池 |
| `/sessions/abort` / `retire` | POST | 中断 / 清除会话 |
| `/agent/*` | GET/POST | 工具回调（需双头） |

---

## 13. 配置参考（`config.json`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `qq.wsUrl` | — | OneBot 正向 WS |
| `qq.httpUrl` | — | OneBot HTTP API（留空全走 WS） |
| `qq.accessToken` | `""` | OneBot token |
| `model.baseUrl` | — | 模型端点 |
| `model.provider` | `deepseek` | provider 名 |
| `model.model` | — | 模型 ID |
| `model.apiKey` | `""` | 留空读 `DEEPSEEK_API_KEY` |
| `model.thinkingLevel` | `off` | off/minimal/low/medium/high |
| `model.maxTokens` | `2048` | 单次输出上限 |
| `persona.systemPrompt` / `systemPromptFile` | — | 人设（文件优先） |
| `memory.enabled` / `maxRecords` / `maxResults` / `autoCaptureUtterance` | — | 长期记忆 |
| `socialV2.*` | 见第 9 节 | 二代仿真 |
| `socialV1.*` | 见 9.9 | 一代仿真 |
| `allow` / `deny` | — | 白名单 / 黑名单 |
| `tools.enabled` | `true` | 是否挂 QQ 工具 |
| `sendDelayMs` | `800` | 分条间隔 |
| `ackMessage` | `""` | 收到消息回执 |
| `maxTurnSeconds` | `900` | 单回合总超时 |
| `history.maxMessages` / `summarize` | `120` / `true` | 裁剪与摘要 |
| `internalPort` / `internalHost` | `3210` / `127.0.0.1` | 内部 HTTP |
| `internalToken` | `""` | 自动生成 |

---

## 14. 部署

### 14.1 systemd

```bash
sudo cp lismqq-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now lismqq-bot
journalctl -u lismqq-bot -f
```

单元默认 `MemoryMax=512M`、`CPUQuota=80%`、`SuccessExitStatus=2`（单实例锁主动退出不触发重启风暴）。

### 14.2 start.sh

`setsid` 脱离终端 + while 监督循环 + 5 秒重启 + 日志 5MB 轮转。

### 14.3 低配资源

- 512MB 内存设备可运行；实际占用随会话数、历史长度增长。
- 建议开 256–512MB swap，防 `npm install` / 摘要压缩 OOM。
- 低配优先 `deepseek-flash` 等便宜快模型，少开 thinking。
- `state/` 持续增长，定期清理会话或限制数量。
- 日志：systemd 用 `journalctl --vacuum-size`，start.sh 已轮转。

### 14.4 验证

```bash
curl http://127.0.0.1:3210/status
```

---

## 15. 测试

```bash
npm test                       # 全量离线测试（无需 API Key）
npm run self-test              # 冒烟
node test/social-v2.test.mjs   # v2 状态与触发器
node test/qa-fixes.test.mjs    # 唤醒/观察/硬闸回归
node test/live-longcat.test.mjs # 真机联调（网络测试，不进 npm test）
```

---

## 16. 已知边界与文档偏差

以下以**代码为准**：

1. **`qq_wait_for_messages` 不是 ≤30s 短等待**：代码允许 1–600s（默认 300s），`quietMs` 0–60000（默认 8000）。见 `bridge.js:2182`、`qq-tools-server.mjs:285`。
2. **preSleep 强制观察窗没有完全移除**：409 硬闸仍在（`bridge.js:2216, 2289`）。准确说法是「门槛从必须观察满 N 分钟降为预算动过就放行」。
3. **`agent.steer()` 未接线**：`pi-host.js:547` 定义了 `steer()`，但 `bridge.js` 从未调用。v2 下新消息进 `unread` 队列，由当前回合的 `qq_wait_for_messages` 或下一次唤醒消费。
4. **自定义端点 cost 为 0**：价目表只内置 DeepSeek；LongCat 等 token 照常统计，金额按 0 计。
5. **记忆是词面匹配**：零词面重叠的同义改写召回不到。
6. **未实现**：表情包斗图、语音、主动戳人、多角色卡、斜杠命令。
7. **控制面免鉴权**：监听 `0.0.0.0` 时管理权限依赖局域网/防火墙边界，**不要把端口映射到公网**。

---

## 附：一条消息的完整路径

```
消息进来 → unread（seq）
  → @ ? 直通 : 评估触发器
  → 合并窗口 → 分档限频 → 忙时暂存
  → 排队 _runWakeTurn（一次 agent.prompt）
      → 选批 → 建 prompt → 模型多轮工具循环
          → 回应（首答外发 / 发送工具 / 兜底）
          → 观察（qq_wait_for_messages，12min 预算）
          → 收尾（set_wake_config / mark_read，409 硬闸）
      → 自动 markRead + 防呆 + 分批续读
  → 休眠（diving / 定时睡）
  → 巡逻 / 睡眠 / 回复检查定时器继续叫醒它
```
