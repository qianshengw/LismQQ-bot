# FULL-AUDIT.md — 全功能清单与审查列表

> 2026-10-30 复核说明：本文件是历史清单，行号及部分结论已过时。当前测试为 20 套，runner 不再容忍非零退出；本轮修复与实测边界见 [AUDIT-REPORT-2026-10-30.md](AUDIT-REPORT-2026-10-30.md)。下方旧勾号不代表本轮线上验收。
>
> 生成时间：2026-10-29（终审准备版，覆盖 AUDIT.md）
> 项目：LismQQ-bot（NatCat/OneBot v11 ↔ pi-agent-core 库嵌入版 QQ 仿真桥接）
> 用途：交给另一个 AI 或人工审查者，逐项核实「承诺功能是否真实实现、有无核心 bug、Web 前后端是否成功耦合」。
> 审查基线：17/17 套测试通过、qa-fixes 29/29、浏览器渲染 6/6（本文件生成时实测）。

---

## 0. 审查方法建议

1. 每个条目都给了「验证方法」列：优先跑测试（`npm test`），其次读代码（给了文件:行号锚点），最后跑真机。
2. 标注 🔴 的条目是**高价值审查点**（历史上出过 bug 或逻辑微妙，最值得复核）。
3. 标注 🟡 的条目是「设计取舍」——不是 bug，但审查者应确认自己认可该取舍。
4. 代码行号基于本文件生成时的版本，若代码已改请以函数名/正则锚点定位。

---

## 1. 架构总览（审查者先读）

```
QQ 客户端
  ↕ NapCat（OneBot v11 WS + HTTP）
① src/onebot.js        协议层：原始事件 → {groupId, userId, text, raw} 标准消息
② src/bridge.js        调度层（2628 行）：白名单 → 未读入库 → 触发器评估 → 唤醒/直投决策 → 发送闸门
③ src/wake-scheduler.js 计时层（266 行）：合并窗口/限频/巡逻/睡眠定时/防呆
④ src/pi-host.js       引擎层（663 行）：SessionAgent（pi-agent-core Agent 封装）/SessionManager/记忆注入/裁剪压缩/自洁
⑤ src/mcp/*.mjs        手脚层：qq-tools-server（14 个 QQ 工具）+ web-search-server，经内部 HTTP 回调 bridge
持久化：state/ 下 social-v2.json（v2 状态+记忆）、social-v1.json、sessions/*.json（transcript）、
        memory.json（记忆池）、token-ledger.json（账本）、internal-token、bridge.lock（单实例锁）
Web：public/console.html（Alpine.js 3 本地化）+ public/alpine.js，控制面与工具回调共用内部 HTTP
```

**依赖**：@earendil-works/pi-agent-core / pi-ai / pi-mcp 1.3.0（npm 依赖，未改源码）；typebox。
**运行环境**：Node ≥22.19，目标 Linux ARM64（openstick），当前配置 internalPort=3210 / internalHost=0.0.0.0。

---

## 2. 核心机制清单（承诺功能逐项核实）

### 2.1 唤醒系统（v2 接管，当前生产模式）

| # | 功能 | 实现锚点 | 验证方法 | 状态 |
|---|---|---|---|---|
| 1 | 触发器评估（@/名字/提问/关键词词边界/指定人/任意消息/概率） | social-v2.js `evaluateWakeTrigger`（L94-120），词边界 L109-110 | social-v2.test.mjs 触发器组 | ✅ |
| 2 | @ 直通车（跳过合并窗口） | bridge.js:607-610 `directV2 → scheduleWake(immediate:true)` | 人工/日志 | ✅ |
| 3 | 合并窗口 3s（可配 1-60s） | wake-scheduler.js:102-108；config.socialV2.batchWindowMs | social-v2.test 合并场景 | ✅ |
| 4 | 优先级合并（多因取最高） | WAKE_PRIORITY social-v2.js:78-88；_flushWakes wake-scheduler.js:111-119 | social-v2.test | ✅ |
| 5 | 🔴 限频（唤醒/分=1、唤醒/时=30）+ 重试不丢 | social-v2.js tryRegisterWake:410；wake-scheduler.js:138-153（重试原因压 pendingWakes，60s 后取最高优先级） | social-v2.test「A4 连续限频不丢」 | ✅ |
| 6 | 忙时暂存 + 回合结束补发 | wake-scheduler.js:130-134、setBusy 补发:151-161 | social-v2.test 忙暂存场景 | ✅ |
| 7 | 🔴 巡逻（30-90min 随机 + 概率加权） | wake-scheduler.js:220-248（想法×1.4/刚发言×0.5/深夜×0.3/话痨×0.3，无条件自排） | social-v2.test 假时钟 | ✅ |
| 8 | 睡眠定时（sleepUntil 到点唤醒→恢复无限潜水） | wake-scheduler.js setupSleepTimer:184-198 | social-v2.test 睡眠场景 | ✅ |
| 9 | 🔴 防呆三件套：无触发条件重置 / 空醒≥3 重置 / atMention 保底 | wake-scheduler.js ensureWakeable:257-280、noteNoAction:286-297；bridge.js wake-config 硬钳（diving 强制 atMention=true） | social-v2.test + qa-fixes B6 | ✅ |
| 10 | 手动唤醒 API（key/白名单/接管模式 4xx 校验） | bridge.js manualWake（约 1085）；qa-fixes「manual wake validates」在 repair.test.mjs | repair.test.mjs | ✅ |

### 2.2 回合系统（E：睡前观察长轮询）

| # | 功能 | 实现锚点 | 验证方法 | 状态 |
|---|---|---|---|---|
| 11 | 回合上限 maxTurnSeconds=900（可配 30-3600） | bridge.js:62 loadConfig；config.json:99 | 读代码 | ✅ |
| 12 | 🔴 /agent/wait 长轮询：clamp 1-600s；观察**总时长预算** waitBudgetMs=12min/回合（按实际等待扣减，轮数不限——复刻原版 15min 租约自由度）；预算用完立即返回空+note；单次等待截断到剩余预算 | bridge.js /agent/wait L1644-1668（clamp:1653、截断:1655、预算用完:1657、扣减:1664）；预算初始化在 _runWakeTurn:986/_runV1Turn:1244/_runTurn:1333 | qa-fixes「E：/agent/wait 观察预算」（3 轮短观察多轮通过/预算见底快速返回/用完返回/消息到达按实扣） | ✅ |
| 13 | 🟡 静默窗 quietMs（默认 8000）：收到消息后再静默观察才返回，防对方连发时抢答；0=立即返回 | bridge.js _waitForMessages:2620-2658（quietTimer 逻辑:2639-2645） | qa-fixes 2a 两个用例（连发打包/0 立即返回） | ✅ |
| 14 | 🔴 waiter 泄漏守卫：旧 wait 超时残留的 check 闭包不得消费后继等待的消息 | bridge.js:2637 `if (settled) return; // 旧 waiter`（quietTimer 回调内也有 !settled 判断:2642） | 本轮实测复现过泄漏（wait1 超时→wait2 拿到 0 条），修复后独立复现通过 | ✅ |
| 15 | 收尾流程 prompt（wait 300s 观察/预算说明/退场禁令） | bridge.js:970-978【收尾流程】 | qa-fixes「E：唤醒 prompt 含睡前观察流程」 | ✅ |
| 16 | 🟡 观察硬闸：投喂过未读（hadUnreadThisTurn）却没做过观察（waitBudgetMs 未动）就「设 diving/定时睡」或 mark_read → 409+指引；设 active 不拦；预算用尽放行 | bridge.js wake-config L1681-1691（wantsSleep 判定:1684）、mark-read L1748-1756 | qa-fixes 2b（409/观察后放行/active 不拦/预算用尽 diving 放行/无未读不闸）；repair.test.mjs「management tools」回归保证空 body 不误伤 | ✅ |
| 17 | 分批续读：未读>20 条时回合结束自动排 unreadContinuation | bridge.js finally L1089-1094（!errorMessage && !skipContinuation && running && 剩余未读>0） | repair.test.mjs「V2 batches oldest unread」 | ✅ |
| 18 | 🟡 出错回合：不清未读、不推水位、不续读、不算空醒、记 v2Log | bridge.js:1064-1076（markSeen 带 !errorMessage:1071；errorMessage 提前 return 前先 _v2Log） | qa-fixes A3 | ✅ |

### 2.3 @ 场景强制回应（反失联）

| # | 功能 | 实现锚点 | 验证方法 | 状态 |
|---|---|---|---|---|
| 19 | hasAtMe 判定：reason=atMention / 私聊 / 未读含 atMe/questionToMe | bridge.js:918-920（prompt）与 _runWakeTurn:1001-1003（行为）同口径 | qa-fixes「@ 唤醒 prompt」「私聊唤醒等同 @」 | ✅ |
| 20 | 未读渲染 @ 标注（←@了你 / ←向你提问） | bridge.js:950-951 | qa-fixes 同上 | ✅ |
| 21 | 🔴 @ SILENT 违规处理：不 markSeen、记 lastAtSilentViolationAt、同批（atSilentViolationSeq）只重试一次、skipContinuation 防死循环 | bridge.js:1024-1041 | qa-fixes「@ 场景 SILENT 违规」（未读保留/水位不推/重试调度被调/1.2s 收敛/非 @ 不触发） | ✅ |
| 22 | 直投链（_composePrompt）@/私聊注入禁令 | bridge.js:793-799 | qa-fixes「_composePrompt」 | ✅ |

### 2.4 [SILENT] 与退场话双闸（D）

| # | 功能 | 实现锚点 | 验证方法 | 状态 |
|---|---|---|---|---|
| 23 | isSilentMarker 容忍变体（尾随标点/重复/大小写） | social-v1.js SILENT_MARKER_RE:96-98 | message-quality.test | ✅ |
| 24 | stripSilentMarkers 剥散落标记 | social-v1.js:101-103 | message-quality.test | ✅ |
| 25 | 🔴 isFarewellPhrase 退场话正则（整句≤20 字：撤了/去忙/吃饭/告辞/回见/下线/闪了/溜了/撤退/收工…带标点变体） | social-v1.js FAREWELL_PHRASE_RE:106-108、isFarewellPhrase:109-113 | message-quality.test（13 断言） | ✅ |
| 26 | 退场话+SILENT 全出口拦截（**共 6 个出口**）：①_runWakeTurn 兜底（整条+分条过滤）②sendToQQ（整条+分条）③_runV1Turn 分条 filter ④/agent/send（toSend filter+循环内兜底）⑤/agent/reply 整条闸 ⑥/agent/burst（burstInput filter+循环内 strip） | bridge.js:1043-1060（兜底）、1368-1375（sendToQQ）、1180（v1 分条）、1509-1511/1528（send）、1633-1639（reply）、1652-1657（burst） | qa-fixes「SILENT 闸」「D2：退场话闸」 | ✅ |
| 27 | v1 farewell 安静退场（删告别语要求） | bridge.js _buildFarewellPrompt:1214-1222 | qa-fixes D3 | ✅ |

### 2.5 上下文注入族（1）

| # | 功能 | 实现锚点 | 验证方法 | 状态 |
|---|---|---|---|---|
| 28 | 时间观念【现在】：当前时间+未读距今+上次发言距今+上次醒来距今 | bridge.js _buildTimeSenseLine:850-873、调用:938 | qa-fixes「1a/1c」 | ✅ |
| 29 | 自我身份【你是谁】：persona.name + myQQId + 如何被叫 | bridge.js _buildIdentityLine:876-880、调用:940 | 同上 | ✅ |
| 30 | 参与度【节奏】：近 1h 发言量→收敛/活跃软指引 | bridge.js _buildParticipationLine:883-888、调用:942 | 同上 | ✅ |
| 31 | 🔴 唤醒原因剧本 _buildReasonHint：proactiveCheck/replyCheck/timeout/poke/unreadContinuation/manual 各自引导（atMention 空——由【重要】段承担） | bridge.js:891-912、调用:935 | qa-fixes「1a/1c」（巡逻剧本+不强制回应） | ✅ |
| 32 | 🔴 会话初始提示词 initialPrompt：social-v2 状态字段（social-v2.js:149）；POST 端点（bridge.js:2133-2146，重置 bootstrapSent）+ GET（2148-2156）；bootstrap 段注入（928-932）；控制台编辑（console.html 二代仿真详情区） | social-v2.js:149、bridge.js:2133/2148/929-932、console.html v2InitialPrompt+saveV2InitialPrompt | qa-fixes「1b」（首次注入/bootstrap 后不注入/POST 重置/GET 回读） | ✅ |

### 2.6 transcript 完整性（历史修复，防持久 400）

| # | 功能 | 实现锚点 | 验证方法 | 状态 |
|---|---|---|---|---|
| 33 | 🔴 _sanitizeTranscript：孤儿 toolResult 删除、无结果 toolCall 剥除、空 assistant 删除；每次 prompt() 入口调用 | pi-host.js _sanitizeTranscript:442-490、prompt() 调用:493 | pi-host.test（A2 单测+error 端到端） | ✅ |
| 34 | 🔴 裁剪切点前移：保留段开头不能是 toolResult（防 API「Cannot resolve tool name」持久 400） | pi-host.js _trimHistoryAsync:342-347 | pi-host.test（A1） | ✅ |
| 35 | 摘要压缩：超 maxMessages 把旧区段压成 summary:true 消息（滚动合并、失败降级硬丢） | pi-host.js _trimHistoryAsync:316-360、summarizeMessages:368-424 | compaction.test | ✅ |
| 36 | 恢复时强制替换 system 消息（新人设盖旧人设） | pi-host.js applyCurrentSystemMessage:110-136 | persona-hotreload.test | ✅ |

### 2.7 记忆系统（新版独有优势）

| # | 功能 | 实现锚点 | 验证方法 | 状态 |
|---|---|---|---|---|
| 37 | 记忆池：CJK bigram 检索/停用词/重叠打分/utterance 分区隔离 | src/memory-pool.js 全文 | memory-pool.test（16 断言） | ✅ |
| 38 | transformContext 自动注入偏好块 + memory_write 工具 + captureUtterance | pi-host.js:277-295（注入）、189-204（工具）、522-533（捕获） | pi-host.test | ✅ |
| 39 | v2 群友记忆三分类（topic/thought/impression）+ 印象原型安全（Object.hasOwn+defineProperty）+ 水位钳制 | social-v2.js appendMemory:279、touchImpression:316-335、markSeen:260-267 | social-v2.test + repair.test「impression deletion」 | ✅ |

### 2.8 发送与安全

| # | 功能 | 实现锚点 | 验证方法 | 状态 |
|---|---|---|---|---|
| 40 | 🔴 发送限频统一账本：_sendToSession 非预占路径 reserveSendSlots(1)，burst/send 预占+按实际未发数回滚；全部发送链共用 _sendBudget() | bridge.js:2585-2618（_sendToSession）、burst 端点 M6 回滚:1694 | qa-fixes S4 + repair.test「send failure refunds」 | ✅ |
| 41 | 出站脱敏双闸门（精确名单+启发式） | src/sensitive.js + bridge.js redactAll 调用点 | security.test | ✅ |
| 42 | 白名单：收侧 isAllowed（deny 优先）、发侧 _sessionSendable 复核 | bridge.js:101-111、2571-2583 | bridge.test + qa-fixes B3/S3 | ✅ |
| 43 | 图片抓取防内网（safe-fetch：SSRF/重定向/私网段拒绝） | src/safe-fetch.js + media.js | security.test + qa-fixes M7 | ✅ |
| 44 | 🔴 控制面免鉴权（用户决策）：/ 非 /agent/ 路由只做 Origin-Host 一致性校验；/agent/* 保持 x-console-token + x-agent-call 双头 | bridge.js _authed:1474-1486 | qa-fixes B1 + repair.test「console plane is token-free」 | ✅（设计决策已确认） |
| 45 | 单实例锁（PID 存活检测+崩溃自愈接管） | bridge.js acquireInstanceLock:241-269 | deployment.test | ✅ |
| 46 | 审批回调按会话绑定（beforeToolCall 白名单复核，防并发串号） | bridge.js:443-447（factory）、1443-1450（_approveToolCall） | qa-fixes S1 | ✅ |

### 2.9 MCP 工具面（14 个）

| # | 工具 | 功能 | 状态 |
|---|---|---|---|
| 47 | qq_get_unread_messages | 读未读（x-qq-session 绑定当前会话） | ✅ |
| 48 | qq_get_group_history | 当前群历史（私聊恒空——审查点：原版支持任意群+翻页，新版简化） | ✅（已知简化） |
| 49 | qq_send_message | 单发（SILENT/退场话过滤、限频预占） | ✅ |
| 50 | qq_reply | 引用回复（同上闸门） | ✅ |
| 51 | qq_list_groups / qq_get_group_members | 群列表/成员 | ✅ |
| 52 | qq_get_message_images | 查消息图片（⚠️ 已知弱化：只返回 URL 不返回图像内容——模型不能按需「看」） | ✅（已知简化） |
| 53 | qq_get_forward_msg | 合并转发展开（⚠️ 返回原始 JSON，可读性一般） | ✅（已知简化） |
| 54 | 🔴 qq_set_wake_config | 设唤醒配置（经硬闸+钳制链：400 类型校验→4h 上限→mode 归一→atMention 保底→409 观察闸） | ✅ |
| 55 | qq_mark_read | 确认已读（409 硬闸） | ✅ |
| 56 | qq_memory | 记忆三分类增删查（⚠️ 原版是 4 独立工具+自定义过期；新版单工具、thought 固定 2h） | ✅（已知简化） |
| 57 | qq_send_burst | 连发（SILENT/退场话条目剔除、限频预占回滚） | ✅ |
| 58 | 🔴 qq_wait_for_messages | 睡前观察（timeoutSeconds≤600、quietMs 静默窗、预算在桥接侧扣减） | ✅ |
| 59 | qq_session_status | 会话状态查询 | ✅ |
| 60 | AsyncLocalStorage 会话隔离 + 同会话串行/跨会话并发 | qq-tools-server.mjs:27/340/356-366 | qq-tools-server.test + mcp-session-binding.test | ✅ |

### 2.10 v1 传统仿真（当前 v2 接管模式下休眠，灰度备用）

| # | 功能 | 实现锚点 | 状态 |
|---|---|---|---|
| 61 | 四相状态机（观望/活跃/试探/退场）+ 5 秒心跳 | social-v1.js + bridge.js _v1Tick | ✅ |
| 62 | 沉默概率 shouldSkipInActive（15% 基础/60s 内归零/积压减压） | social-v1.js:396-405 | ✅ |
| 63 | ⚠️ **v1 在 socialV2.mode='v2' 时零参与**（bridge.js:618 return 挡住所有消息）——设计如此（对齐原版单模式），审查者须知 v1 参数当前不生效 | bridge.js:618 | ✅（设计决策） |
| 64 | farewell 安静退场（D3） | bridge.js:1214-1222 | ✅ |

---

## 3. Web 控制台耦合审查清单

### 3.1 视图（8 个）

`overview / sessions / usage / memory / persona / access / socialv2 / socialv1`

### 3.2 前后端 API 耦合矩阵（api() 调用 ⊆ 桥接路由）

以下 **25 个前端调用**逐一核对后端路由存在（静态扫描测试「console.html 的 api() 路径 ⊆ 桥接路由集合」每次 qa-fixes 自动跑）：

| 前端调用 | 后端路由 | 用途 |
|---|---|---|
| /status | ✅ /status | 总览 |
| /api/tokens/summary、/api/tokens/series | ✅ | 用量页+图表 |
| /memory | ✅ | 记忆池页 |
| /api/persona | ✅ | 人设编辑 |
| /sessions/abort、/sessions/retire | ✅ | 会话中断/清除 |
| /api/whitelist | ✅ | 访问控制页 |
| /api/model | ✅ | 模型热切换 |
| /api/runtime | ✅ | 运行参数 |
| /api/simulation | ✅ | v1/v2 热开关 |
| /api/socialv2/states、/activity、/schedule、/wake、/reset、/config、/memory | ✅ | 二代仿真页 |
| **/api/socialv2/state?key=** | ✅ | 会话详情（**含 initialPrompt 字段**，本轮新增） |
| **/api/socialv2/initial-prompt** | ✅ GET+POST（**本轮新增**） | 初始提示词保存 |
| /api/socialv1/* 四个 | ✅ | 一代仿真页 |

🔴 **重点人工复核**（自动测试覆盖不到的交互细节）：
- [ ] 二代仿真详情页：输入 key → 查看 → 初始提示词 textarea 是否正确回显当前值
- [ ] 保存初始提示词 → 提示「已保存（下次首次唤醒注入）」→ 再查看回显一致
- [ ] 列表页「@ 失联」红色 pill 只在 wakeable=false 时出现；「⏰ 时间」只在 hasTimer 时出现
- [ ] @我（保底）checkbox 勾选被锁定（@change 强制 true）
- [ ] 触发器保存 → 重进详情回显一致（speakerIdsStr/keywordsStr 往返）
- [ ] 定时唤醒 datetime-local 设定/取消往返
- [ ] 浏览器渲染验证脚本（test/browser-final.cjs）6/6：ready class、8 导航、三视图文字、机器人 QQ

### 3.3 前端状态字段核对

- [ ] `v2InitialPrompt` 状态存在（console.html 数据段）且 v2Detail() 时从 `r.initialPrompt` 填充
- [ ] `saveV2InitialPrompt()` 走 POST {sessionKey, initialPrompt}
- [ ] `msg.v2init` 提示位存在
- [ ] states 列表行使用 `s.hasTimer / s.wakeable / s.triggers`（后端已返回）
- [ ] 列表模式 pill：`s.hasTimer` 显示 ⏰（不再依赖旧的 diving&&!infinite 条件）

---

## 4. 🔴 核心 bug 扫描清单（重点复核区）

以下是**历史踩过坑或逻辑微妙**的点，审查者应逐一确认当前实现无回归：

| # | 扫描点 | 为什么危险 | 当前防线 |
|---|---|---|---|
| B1 | 预算扣减的准确性：wait 提前返回（消息到达）时只扣实际耗时；超时扣满额 | 扣多→观察额度虚少；扣少→预算永不枯竭（死循环风险） | waitStart→Date.now 实扣（bridge.js:1664）；测试断言 3 轮后预算 ≈ 满额-3s |
| B2 | settled 守卫完整性：quietTimer 回调是否也检查 settled | 旧 quietTimer 在后继等待期间触发会消费后继消息 | quietTimer 回调内 `!settled &&` 检查（bridge.js:2642）；finish 清 quietTimer |
| B3 | 硬闸误伤面：wantsSleep 判定是否过宽 | 空 body/管理触发器被拦 → 模型工具链断裂（曾炸 repair 测试） | 只拦 `mode==='diving' || infinite===false` 显式转换；active/空 body/触发器编辑放行 |
| B4 | 违规重试死循环：SILENT 违规 + unreadContinuation 咬合 | 同批未读不 markSeen → finally 续读每轮触发 → 无限唤醒 | skipContinuation 标志 + atSilentViolationSeq 同批只重试一次（双层） |
| B5 | 限频重试顶掉：多次被限频的唤醒互相覆盖 | 后到的唤醒顶掉先到的重试定时器 → 丢失 | wake-scheduler.js:141-152 重试原因入 pendingWakes、wakeRetry 定时器取最高优先级 |
| B6 | 裁剪切点落在 tool 配对中间 | 持久 400「Cannot resolve tool name」 | pi-host.js:342-347 切点前移 + _sanitizeTranscript 双保险 |
| B7 | error/abort 回合残骸（孤儿 toolResult/无结果 toolCall） | 同上，且会永久卡死会话 | 每轮 prompt() 前 _sanitizeTranscript 自洁 |
| B8 | Windows libuv 退出噪音（Assertion failed async.c） | 测试误判失败 | run-tests.mjs 以「套内断言」判定，非零退出仅记 warning——审查者可忽略该噪音（exit 码仍以断言为准） |
| B9 | handleIncoming 的 running 门：pushIncoming 需 running=true | 测试/启动早期消息丢失 | 设计如此（start() 后才收消息）；审查者确认生产 start 时序无碍 |
| B10 | myQQId 竞态：getLoginInfo 异步返回前收到的 @ | _isAtMe 退化为「有 at 段即命中」（宽松方向，宁可多响应） | bridge.js:810；_refreshIdentity 定时刷新 |
| B11 | initialPrompt 对「未唤醒过的群」不可预写（POST 要求 socialV2.has(key)） | 新群没有 v2 状态 → 无法预写背景，必须等首条消息触发状态创建 | 🟡 已知限制（白名单群首条消息即建状态，随后可写）；如需预写需加 ensure 逻辑 |
| B12 | JSONC 注释剥离：`^\s*//` 只删整行注释 | 行尾注释/BOM 会让 JSON.parse 崩 → 进程退出 | 已知限制：config.json 保持整行注释风格；审查者检查部署的 config 无行尾注释 |
| B13 | wait 端点无回合时调用（外部 curl）累积预算扣减 | waitBudgetMs 兜底初始化在端点内（undefined 时设满额）→ 无回合调用只影响 runtime 对象，回合开始时重置 | bridge.js:1650 兜底；回合开始三处重置 |
| B14 | sendToQQ 的 safe 为空仍进入 segments 循环 | safe 空时 splitForQQ 返回空数组，循环不执行——无 bug，但审查者可确认 | splitForQQ 空串返回 []（md-to-plain.js） |
| B15 | SILENT 违规 return 跳过 ensureWakeable/noteAction | 违规回合不参与防呆计数（noteNoAction）——模型连续违规不会触发空醒重置 | 🟡 设计取舍：防呆针对「真空醒」，违规有自己的重试链；审查者确认可接受 |

---

## 5. 已知简化与未实现（对齐原版的差距，非 bug）

| # | 项 | 原版 | 新版 | 影响 |
|---|---|---|---|---|
| S1 | 表情包体系（6 工具+斗图策略） | 有 | 无 | 高频拟真互动缺失 |
| S2 | 黑话学习全链路 | 有 | 无 | 接不住圈内梗 |
| S3 | 发语音 | 有 | 无 | 不能开口 |
| S4 | qq_send_poke 主动戳人 | 有 | 无（prompt 已移除引用防幻觉） | 少互动手段 |
| S5 | wait purpose=reply/messages 两用 + 观察有效性判定（≥5min 才算） | 有 | 无（单一等待+静默窗） | 边角抢答场景 |
| S6 | 群历史任意群+翻页；防复读自查（qq_get_my_recent_messages）；单条详情；活跃成员 | 有 | 无 | 回溯/防复读弱 |
| S7 | 多角色卡/闭环管理端/QQ 斜杠命令/反馈通道 | 有 | 无 | 管理走控制台 |
| S8 | 图片：8MB/64MP/5 张/GIF 抽帧 | 有 | 1MiB/3 张/GIF 整图 | 大图动图看不懂 |
| S9 | v1 参数默认值偏保守（skipProbability 0.15 vs 0.05 等） | — | — | v1 灰度时更「高冷」 |
| S10 | preSleep 观察有效判定（见 S5） | 有 | prompt 引导+预算+硬闸近似 | 基本对齐 |

**新版独有（原版没有）**：长期记忆池自动注入、模型热切换零重启、摘要压缩、仿真热开关、调度参数可视化、发送限频预占/回滚、分批续读、@ 违规重试、观察时间预算制、会话中断、单实例锁自愈。

---

## 6. 测试基线（审查者可直接复跑）

| 套件 | 内容 | 断言数 | 状态 |
|---|---|---|---|
| npm test（17 套） | 全量：memory-pool/onebot/pi-host/bridge/security/message-quality/social-v2/social-v1/console-pages/deployment/qa-fixes/qq-tools-server/mcp-session-binding/persona-hotreload/runtime-endpoint/compaction/repair | — | ✅ 17/17 |
| qa-fixes.test.mjs | 今天全部修复的回归（29 用例，清单见 qa-fixes 文件内测试名） | 29 | ✅ |
| 浏览器 test/browser-final.cjs | 真实 headless Chromium 渲染 console.html | 6 | ✅ |
| live-*（未注册进 npm test） | 长 Cat 真端点/v1 真机/v2 真机 | — | 需真实凭证，默认跳过 |

**Windows 已知噪音**：libuv `Assertion failed ... async.c, line 94`（exit 3221226505）出现在部分套件正常结束后——非测试失败，runner 已容忍。

---

## 7. 部署检查单（上线前）

- [ ] 服务器文件与本地一致：src/bridge.js、src/social-v2.js、src/social-v1.js、src/pi-host.js、src/wake-scheduler.js、src/mcp/qq-tools-server.mjs、public/console.html、public/alpine.js
- [ ] config.json：**服务器自有的真实凭证**（apiKey/wsUrl/白名单），只手动改 `maxTurnSeconds: 900`；确认无行尾注释、无 BOM
- [ ] `npm install` 已在服务器执行过（node_modules 有 @earendil-works 三包）
- [ ] `node src/bridge.js` 前台验证：出现 `内部 HTTP 就绪 http://0.0.0.0:3210（局域网...，控制面免鉴权）` 与 `机器人身份: <QQ>`
- [ ] 转后台：`./start.sh` 或 systemd；`ss -tlnp | grep 3210` 确认监听
- [ ] 浏览器打开 http://172.16.200.116:3210：8 导航渲染、二代仿真页正常
- [ ] 真机冒烟：群里 @ 机器人 → Web 活动日志出现「唤醒（atMention）」→ AI 回复含上下文标签行为 → 说完后日志出现观察行为 → 无「我先撤了」话术
- [ ] state/ 目录权限（Linux：建议 chmod 700 或 systemd ProtectHome）

---

## 8. 审查结论模板（供审查者填写）

```
1. 承诺功能核实：60 项中 ✅___ 项、⚠️___ 项（列偏差）、❌___ 项（列缺失）
2. 核心 bug：发现 ___ 个（按 §4 格式列：扫描点/复现步骤/建议修复）
3. Web 耦合：§3.2 矩阵核对结果 + §3.3 人工复核项勾选结果
4. 设计取舍异议（§2 🟡 与 §5）：列出不同意项及理由
5. 上线判定：GO / GO WITH NOTES / NO-GO（附理由）
```
