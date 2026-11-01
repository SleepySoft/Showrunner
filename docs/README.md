# Showrunner 文档导航

文档按 **WHY → WHAT → HOW → ADR** 组织：先理解问题和边界，再了解系统组成，然后执行具体任务；需要追溯技术取舍时查阅 ADR。

## WHY：为什么做

Showrunner 要解决的不是“如何限制一个普通播放器”，而是“如何从结构上让电视只播放家长编排的内容”。因此选择权留在遥控器与服务器，电视是只执行当前播出状态的终端。

这带来三个首要目标：

1. **内容可控**：电视不接触推荐流和完整内容目录。
2. **播出可预测**：频道、合集、时间点、播放上限和空闲画面都由服务器状态机决定。
3. **家庭可运维**：单机部署、数据可搬迁、离线可播，并能临时维护或释放电脑。

完整问题定义、信任边界和设计原则见 [架构设计](ARCHITECTURE.md#why为什么这样设计)。

## WHAT：系统是什么

| 部分 | 职责 | 入口 |
|---|---|---|
| 手机遥控器 | 登录、编排频道/合集/时刻表、控制播放和维护 | `/remote/` |
| PC 服务端 | 权威状态机、片库、缓存、调度、鉴权和持久化 | `src/server.js` |
| 电视播放端 | 接收当前播出状态、播放、上报进度和结束 | `/tv/` |
| 网站源层 | 识别网站、解析标题/合集、修补站点元数据 | `src/sources/` |
| 本地数据 | 配置、频道状态、缓存索引和媒体缓存 | 程序同级 `<程序目录名>-data/` |

组件关系、数据模型和运行流程见 [架构设计](ARCHITECTURE.md#what系统由什么组成)。

## HOW：如何使用和扩展

| 目标 | 文档 |
|---|---|
| 安装、打包、开机启动、维护和公网反代 | [部署指南](DEPLOY.md) |
| 非 kiosk 联调、断点、DevTools 和日志定位 | [调试指南](DEBUGGING.md) |
| 调用 REST / WebSocket 接口 | [API 参考](API.md) |
| 运行测试、理解覆盖范围 | [测试说明](TESTING.md) |
| 新增 B 站之外的网站兼容层 | [网站源适配器](SOURCES.md) |
| 理解状态机、缓存、合集和调度实现 | [架构设计](ARCHITECTURE.md#how系统如何工作) |

## ADR：为什么选择这种实现

ADR（Architecture Decision Record）记录已经作出的架构决定、当时上下文、替代方案和后果。它解释“为什么”，但不代替 HOW 手册。

- [ADR 索引与约定](adr/README.md)
- [0001：服务器权威播出状态](adr/0001-server-authoritative-playback.md)
- [0002：网页片源优先预下载缓存](adr/0002-prefetch-web-sources.md)
- [0003：网站源使用注册表与独立适配器](adr/0003-source-adapter-registry.md)
- [0004：家庭单机场景使用原子 JSON 持久化](adr/0004-atomic-json-storage.md)
- [0005：公网仅开放遥控平面](adr/0005-public-control-plane-only.md)
- [0006：播放异常第一阶段采用“记录并跳过”](adr/0006-skip-and-log-playback-issues.md)
- [0007：Showrunner 托管浏览器保持单实例](adr/0007-single-managed-browser-instance.md)
- [0008：频道与合集作为独立用户资产](adr/0008-channel-collection-assets.md)
- [0009：电视端采用最小共同遥控器按键](adr/0009-minimal-tv-remote-input.md)
- [0010：首次运行通过电视一次性配对](adr/0010-first-run-tv-pairing.md)
- [0011：本地媒体失败后按需生成兼容缓存](adr/0011-local-media-compatibility-fallback.md)
- [0012：同级双目录与人工确认迁移](adr/0012-confirmed-sibling-data-layout.md)
- [0013：本机电视确认的密码恢复](adr/0013-tv-confirmed-password-recovery.md)
- [0014：播放端支持可选 Chrome 与 mpv 前端](adr/0014-selectable-playback-frontends.md)
