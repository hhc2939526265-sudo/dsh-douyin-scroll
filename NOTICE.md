# 来源与致谢（NOTICE）

本插件 `dsh-douyin-scroll`（中文「刷抖音」，v0.3.7）是在下列两个 MIT 开源项目的基础上，
按 DSH 插件同构规范整理、修复并验证而成的派生作品：

- **dsh-douyin-scroll**（抖音版的直接蓝本）
  https://github.com/NEWJO123/dsh-douyin-scroll （MIT）
  —— 抖音采集（只读推荐流 `tab/feed` + `hot/search`）、证据包打分、无头 Chrome 私信/卡片/评论、
  签名只读、设置页、MCP server、selfcheck 等绝大部分实现来自该项目。
- **dsh-bili-scroll**（架构参照）
  https://github.com/c1overzz/dsh-bili-scroll （MIT）
  —— DSH 值班链路的整体架构来源：bundle patch、宿主依赖三级兜底（`lib/hostdeps.mjs`）、
  谷时定时器、headless 跑一轮、章程记账（`ensureCharter`）、家目录与配置规范、评论复核等。

本版本相对直接蓝本的改动见 [CHANGELOG.md](CHANGELOG.md) 的 0.3.7 条目，主要是：
干净环境自检全绿（人设身份牌 / hooksPath 误判）、默认人设补齐、Linux/macOS 桌面通知。

## 许可证

继承上游，使用 **MIT** 许可证，详见 [LICENSE](LICENSE)。
你可以使用、修改、再分发与商用，但须保留版权声明与 MIT 许可证全文。

## 第三方组件

- 运行时 Python 依赖（由插件在其家目录自建 venv 安装，不随包发布）：
  `curl_cffi`（MIT）、`httpx`（BSD-3-Clause）。
- Node 侧宿主依赖（由 DSH profile 提供或回退到包内 `dependencies`）：
  `@deepseek-ai/schemastery`。

## 风险提示

本插件属于**个人学习性质的自动化**：会把你本人的抖音登录 Cookie 交给本机脚本，
调用抖音非官方接口，可能违反抖音用户协议；账号风险由使用者自行承担。
自动发送（私信 / 卡片 / 评论）默认关闭，且每一道都有 `confirm` 闸。
