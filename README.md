# 局域网智能遥控器（Web 版）

用手机浏览器遥控 Windows 电脑：控制视频播放、模拟鼠标键盘、一键执行宏，还能用自然语言下指令。免安装 App，电脑跑一个小程序，手机扫码/输地址即用。

## 功能特性

### 播放控制
- 播放/暂停、上一集/下一集、快进/快退 10 秒、音量加减、静音
- **拖动顶部进度条跳转**到任意位置（有播放时长时进度条会显示可拖动的圆点）
- **音量滑杆**精确调节音量（0-100%，拖动时自动合并命令，不刷屏）
- **全屏**（方向键左上角小键，仅视频语义显示）：优先点击站点真实全屏按钮（弹幕控件一起全屏），失败自动回退 Fullscreen API / 物理 F 键
- **长按倍速**：按住按钮 2 倍速播放，松开恢复原速（无扩展时回退为长按 → 方向键）
- 浏览器扩展在线时直接精确控制网页 `<video>`；离线时自动回退模拟按键（空格、F1/媒体键等）

### 电视遥控式选片
- 十字键 ▲◀▶▼ 在 B站/YouTube 首页**空间导航选视频**（紫色高亮 + 自动滚动居中）
- **OK** 打开选中视频，**↩ 返回** 上一页；移动时手机端显示视频标题
- **电脑上没开浏览器时，OK 直接打开 B 站**（扩展离线由电脑端启动默认浏览器；浏览器在线但在不可控页面时同样生效）
- B站首页 **🔄换一换**（方向键右上角小键，仅网格语义显示）一键刷新推荐流（其他网页则刷新整个标签页）
- 角落小键（全屏 / 换一换）刻意做得比方向键小，避免误触；只在该语义下出现

### 鼠标键盘
- 触摸板：单指移动、轻点左键、双指点按右键、双指滚动，灵敏度可调
- 键盘：快捷键（Esc/Tab/Enter/方向键/弹幕开关 D/全屏 F 等）、文本输入、组合键（如 `ctrl+c`）

### 宏系统
- 录制全局键鼠操作自动生成宏，或手动编辑 JSON
- 一键回放复杂操作序列（如"打开 B 站并自动播放"）
- 手机端增删改查，立即生效

### AI 自然语言控制（服务端保留，手机界面已移除）
- v1.1.0 起手机端不再显示 AI 输入框：日常遥控用五键 + 触摸板 + 角落快捷键已经够快
- 服务端 `ai_query` 命令与 `AiService` 完整保留，接入模型后仍可通过协议或手机语音助手调用
- 支持内置中文规则解析（离线可用）或接入 OpenAI 兼容接口（含 Ollama 本地模型）
- AI 生成的命令同样经过白名单校验后执行；**具体适用场景见下文「AI 能力」章节**

## 系统架构

```
┌─────────────┐   HTTP/WS :5000    ┌──────────────────────────┐
│  手机浏览器   │ ◄────────────────► │  电脑端 RemoteControl.exe │
│  PWA 遥控面板 │    JSON 消息        │  - Kestrel 静态页 + /ws   │
└─────────────┘                    │  - SendInput 输入模拟      │
                                   │  - 宏引擎 / AI 模块        │
                                   └──────────┬───────────────┘
                                              │ ws://127.0.0.1:8972
                                              ▼
                                   ┌──────────────────────────┐
                                   │  浏览器扩展 (Chrome/Edge)  │
                                   │  精确控制网页播放器/页面元素 │
                                   └──────────────────────────┘
```

- 手机端只与电脑端服务通信；电脑端作为中枢路由指令、执行本地输入模拟、转发扩展命令
- 扩展未连接时媒体命令自动回退为模拟按键，功能降级但依然可用
- 纯局域网运行，无外部服务器依赖

## 技术栈

| 端 | 技术 |
|----|------|
| 电脑端 | .NET 9（WinForms 托盘 + Kestrel），**零外部 NuGet 依赖**（SendInput P/Invoke 自实现输入模拟） |
| 手机端 | 原生 HTML/CSS/JS，PWA（可添加到主屏幕，Service Worker 缓存） |
| 扩展 | Chrome / Edge MV3（Chromium 通用），原生 JS |

## 目录结构

```
pCtrl/
├── server/RemoteControl.Server/     # 电脑端 .NET 项目
│   ├── Program.cs                   # 入口：托盘/无托盘模式、Web 宿主
│   ├── Models/                      # 配置与消息模型
│   ├── Services/
│   │   ├── CommandDispatcher.cs     # 命令分发（白名单校验、扩展优先+回退）
│   │   ├── InputSimulatorService.cs # SendInput 键鼠模拟
│   │   ├── MacroService.cs          # 宏存储与执行
│   │   ├── MacroRecorder.cs         # 全局钩子录制宏
│   │   ├── ExtensionBridge.cs       # 扩展 WebSocket 桥接（8972）
│   │   ├── RemoteSessionManager.cs  # 手机端会话与广播
│   │   ├── AiService.cs             # 自然语言 → 结构化命令
│   │   └── TrayIconService.cs       # 托盘图标与菜单
│   └── wwwroot/                     # 手机端页面（index.html / css / js / sw.js）
└── extension_v2/                   # 浏览器扩展（manifest.json / background.js / content.js）
```

## 快速开始

### 1. 构建电脑端

```powershell
dotnet build server/RemoteControl.Server/RemoteControl.Server.csproj -c Debug
```

产物：`server/RemoteControl.Server/bin/Debug/net9.0-windows/RemoteControl.exe`

### 2. 运行

双击 `RemoteControl.exe`（托盘模式）或调试用：

```powershell
.\RemoteControl.exe --no-tray
```

控制台会打印局域网访问地址（如 `http://192.168.31.46:5000`）和 **6 位配对码**。

### 3. 安装浏览器扩展（可选但推荐）

1. 打开 `edge://extensions`（Chrome 为 `chrome://extensions`）
2. 开启"开发人员模式" → "加载解压缩的扩展" → 选择 `extension_v2/` 目录
3. 扩展会自动连接本机 `ws://127.0.0.1:8972`；连接成功后手机端状态栏显示"扩展已连接"
4. 代码更新后需在扩展管理页点扩展卡片上的"重新加载"，或重启浏览器

临时加载方式：完全退出浏览器后用命令启动（关闭浏览器后需重新执行）：

```powershell
Start-Process msedge.exe -ArgumentList '--load-extension="<你的仓库路径>\extension_v2"'
```

> 注意：推荐用第 1 步的开发者模式永久加载（改动代码后点"重新加载"即可）。`--load-extension` 是临时加载且对同路径目录可能有脚本缓存，若改了扩展代码没生效，请复制目录为新的路径名再加载。

### 4. 手机连接

1. 手机浏览器（与电脑同一局域网）访问电脑端显示的地址
2. 首次输入 6 位配对码，配对成功后 Token 持久化，之后免配对自动连接
3. 可通过浏览器"添加到主屏幕"获得类 App 体验（PWA）

## 配置说明

`config.json` 与 exe 同目录（首次运行自动生成）：

```json
{
  "port": 5000,                      // 手机端 Web 服务端口
  "extensionPort": 8972,             // 扩展桥接端口
  "pairingCode": "123456",           // 6 位配对码（首次运行自动随机生成，勿外传）
  "token": "",                       // 配对成功后签发（自动持久化，勿泄露）
  "deviceName": "MY-PC",             // 手机端状态栏显示的设备名
  "ai": {
    "provider": "none",              // none=内置规则解析 | openai=OpenAI 兼容接口
    "baseUrl": "http://127.0.0.1:11434/v1",  // Ollama 地址；OpenAI 为 https://api.openai.com/v1
    "apiKey": "",
    "model": "gpt-4o-mini"
  }
}
```

`macros.json` 存储宏定义，可手动编辑，步骤类型：

| 类型 | 说明 |
|------|------|
| `key_press` | 单键 `{ "key": "space" }` |
| `key_combo` | 组合键 `{ "keys": ["ctrl", "c"] }` |
| `text_type` | 输入文本 `{ "text": "..." }` |
| `mouse_move` / `mouse_click` / `scroll` | 鼠标操作 |
| `browser_action` | 转发浏览器扩展动作（扩展优先、按键回退） |
| `delay` | 等待毫秒 `{ "ms": 500 }` |
| `execute_macro` | 嵌套执行其他宏 |

## 通信协议

WS 消息统一 JSON 格式（camelCase）：

```json
{ "id": "1", "type": "command", "action": "play_pause", "payload": {}, "timestamp": 1694070000000 }
```

- 手机端连接 `ws://<电脑IP>:5000/ws`，首条消息必须为 `auth`（携带配对码或 Token）
- 电脑端返回 `response`；扩展主动推送 `event`（如 `playback_state` 播放状态）会广播给所有手机

### 支持的命令（action）

| 分类 | 命令 |
|------|------|
| 系统 | `ping` `get_info` `get_status` `auth` |
| 播放 | `play_pause` `play` `pause` `next_episode` `prev_episode` `seek_forward/seek_backward {seconds}` `seek_to {time}` `fullscreen` |
| 浏览器 | `browser_open {url}`（扩展在线时在当前标签打开；浏览器没开则启动默认浏览器） |
| 音量 | `volume_up` `volume_down` `set_volume {value}` `mute` |
| 键鼠 | `mouse_move {dx,dy}` `mouse_click {button}` `scroll {dy}` `key_press {key}` `key_down/key_up {key}` `key_combo {keys}` `text_type {text}` |
| 浏览器扩展 | `browser_action {action, payload}`（动作白名单：play/pause/seek/volume/mute/fullscreen/next_episode/prev_episode/open_url/search/click/get_status/speed_start/speed_stop/tv_nav/refresh_feed） |
| 宏 | `macro_list` `macro_execute {macro_id}` `macro_save` `macro_delete` `macro_record_start/stop/cancel` |
| AI | `ai_query {text}` |

### 浏览器扩展动作亮点

| 动作 | 说明 |
|------|------|
| `fullscreen` | 点击站点真实全屏按钮 → Fullscreen API 兜底 → 服务端回退物理 F 键（应对浏览器手势限制） |
| `speed_start/stop` | 直接改 `playbackRate` 实现长按倍速，精确无副作用 |
| `tv_nav {dir}` | 电视遥控式空间导航：up/down/left/right 移动高亮、ok 打开、back 返回 |
| `refresh_feed` | 点击 B站首页"换一换"（`.feed-roll-btn`）；其他网页 `location.reload()` |

## 平台适配

- **B站**：新版 bpx 播放器全屏按钮 `.bpx-player-ctrl-full`、首页视频卡片 `.bili-video-card`、换一换按钮 `button.roll-btn`、长按倍速、弹幕开关 D
- **YouTube**：全屏、下一集、方向选片（`ytd-*` 渲染器）
- **抖音/西瓜等**：信息流上下条切换（模拟滚轮）
- 其他网站：通用的 `<video>` 元素控制

## AI 能力（服务端保留，界面未开放）

v1.1.0 按需求把 AI 输入框从手机界面移除——日常遥控用五键、触摸板、角落快捷键已经足够快。服务端 `ai_query` 命令、`AiService`（内置中文规则 + OpenAI 兼容接口）完整保留，`config.json` 里配置好 provider 就能用。

**后续这些场景仍然值得启用 AI：**

| 场景 | 说明 / 例子 |
|------|-------------|
| 组合指令一步到位 | "打开B站并播放我的追番" —— 一句自然语言代替 5~6 次按键 |
| 按键表达不了的操作 | "搜索周杰伦的MV"、"跳到 12 分 30 秒"、"音量调到 35%"（不用滑杆微调） |
| 手不方便/看不到屏幕 | 手机语音输入转文字下达指令（开车、做饭、躺着） |
| 本地大模型、隐私可控 | Ollama 跑 Qwen/Llama，指令不出局域网；`baseUrl` 指向 `http://127.0.0.1:11434/v1` |
| 定时/条件自动化 | 宏 + AI 生成步骤序列，做"到点自动打开某站并播放" |
| 手机语音助手联动 | 手机快捷指令 / Tasker / Siri 捷径 → HTTP/WS 调 `ai_query` |
| 多人/长辈使用 | 不用记按钮语义，直接说人话 |

**调用方式**（与手机端同协议，先 `auth` 再发命令）：

```json
{ "id": "1", "type": "command", "action": "ai_query", "payload": { "text": "播放下一集" } }
```

**启用步骤**：`config.json` → `"ai": { "provider": "openai", "baseUrl": "http://127.0.0.1:11434/v1", "apiKey": "", "model": "qwen2.5:7b" }`（Ollama 需先 `ollama serve`）；OpenAI 官方则填 `https://api.openai.com/v1` + apiKey。未配置时 `AiService` 走内置中文规则解析，不联网也能用。

> 需要界面入口时，把 `index.html` 的 AI `<details>` 区块和 `main.js` 里的 `sendAi()` 加回"更多工具"即可（服务端一直没动）。

## 常见问题

**Q: 双击 exe 后手机打不开页面？**
程序已将内容根固定为 exe 所在目录，正常双击即可。若仍 404，确认 exe 和 `wwwroot` 目录在同一文件夹（不要单独拷贝 exe）。

**Q: 全屏偶尔失败？**
浏览器要求全屏由"用户手势"触发。程序触发在页面最近有过交互时通常可用；若被拦截，程序会自动回退发送物理 F 键（B站/YouTube 均支持 F 切全屏）。极少数情况下在电脑网页上点一下鼠标再按全屏即可。

**Q: 全屏时点"全屏"会先取消、又立刻再次全屏？**
已修复（v1.1.0）。旧实现遇到 B站"网页全屏/宽屏"这类站点自绘全屏时，会先点按钮退出网页全屏、再点全屏按钮进浏览器全屏，看起来就是"取消后又全屏"。现在全屏是严格的开关语义：当前处于全屏（浏览器全屏 或 站点自绘全屏）→ 点一下只退出；不在全屏 → 才进入。扩展还会把结果（进入/退出）回传手机端并提示。另外，扩展正在处理全屏时电脑端不再补发物理 F 键，避免两个动作互相打架。

**Q: 手机状态栏老显示"扩展未连接"、偶尔弹提示？**
扩展是 MV3 service worker，浏览器空闲 30 秒会回收它并断开 WebSocket（这是浏览器行为，不是电脑端断线）。v1.1.0 起：扩展每 15 秒发心跳保活，电脑端会探测"半开连接"并按边沿上报状态，掉线后 0.5~5 秒自动重连；手机上"扩展"类提示 5 秒内只弹一次，不再刷屏。若仍频繁出现：在 `edge://extensions`（Chrome 为 `chrome://extensions`）点扩展卡片上的"重新加载"——改过扩展代码必须重载才生效；并确认电脑端服务正在运行。

**Q: 触摸板滑着滑着就没反应（断触）？**
已修复（v1.1.0）。两个原因：① 浏览器把滑动当成页面滚动/缩放，抢走手势并发 pointercancel——触摸板已加 `touch-action:none`；② 抬手事件丢失后残留的指针状态会把后续单指滑动误判成双指滚动，表现为彻底没反应——现在有全局兜底清理 + 异常状态自动重置，取消手势也不再误触发鼠标点击。另外触摸板位移改为约 30ms 合并发送（不再被服务端限流丢包），缩放后的小数位移会累积，灵敏度调低也不会"走不动"。

**Q: 扩展连不上 8972？**
确认电脑端服务已启动；仅限本机连接（127.0.0.1），无需配置防火墙。重启浏览器扩展后会自动重连。

**Q: 手机连不上？**
手机与电脑须在同一局域网；Windows 首次运行可能弹出防火墙授权，选择"允许"。当前 IP 以电脑端控制台/托盘显示为准（局域网 IP 变动后需用新地址）。

**Q: 手机上看不到 AI 输入框了？**
v1.1.0 起按需求把 AI 从界面移除（日常遥控已经够快），服务端能力保留：仍可通过 `ai_query` 协议调用、或接入手机语音助手。适用场景与调用方式见下文「AI 能力」章节。若确实需要界面入口，可以再把它加回"更多工具"里。

## 安全设计

- 配对码 + Token 鉴权，Token 持久化免重复配对
- 命令白名单校验（含 AI 生成的命令与浏览器扩展动作）
- 触摸板等高频事件限流（令牌桶）
- 扩展桥接仅监听本机 127.0.0.1；Web 服务仅监听局域网，不暴露公网

---

**版本**：v1.1.0 ｜ **平台**：Windows 10/11 + Chrome/Edge + 主流手机浏览器 ｜ 需求详见 [需求文档.md](需求文档.md)

### v1.1.0 修复摘要

| 问题 | 原因 | 修复 |
|------|------|------|
| 老是提示扩展断线 | MV3 service worker 空闲被回收断开 WebSocket；电脑端并发发送同一连接抛异常被当成"无响应" | 扩展 15s 心跳 + alarms 唤醒 + 退避重连；电脑端串行化发送、半开连接探测、上下线按边沿上报、扩展提示限频 |
| 全屏时点全屏"取消后立刻又全屏" | 旧逻辑先退出站点"网页全屏"再进入浏览器全屏；扩展超时后电脑端又补发物理 F 键 | 严格开关语义（在就只退、不在才进）+ 切换忙/冷却保护 + 扩展超时不再补按键 + 结果回传提示 |
| 触摸板断触 | 缺 `touch-action:none` 被浏览器抢手势；抬手事件丢失后残留指针误判双指；位移取整归零 + 服务端 30/秒限流丢包 | 手势与指针表自愈、取消不误点击、30ms 合并发送并累积小数位移、服务端限流放宽到 60/秒 |

### v1.1.0 其他优化

| 项 | 说明 |
|----|------|
| 卡键释放 | 长按倍速时若手机锁屏/断线，方向键会一直按着。现在手机切后台会主动松开，电脑端在会话断开时也会统一释放所有按下的键 |
| 连接假死自愈 | 手机锁屏、切 WiFi、路由器漫游时 TCP 可能不报错但消息已收不到。现在连续 2 次 ping 无响应（或 45 秒无任何消息）就自动强制重连，不会出现"显示已连接却点了没反应" |
| 进度条拖动跳转 | 顶部进度条可拖动定位（新增 `seek_to` 命令），拖动时不被服务端状态覆盖，松手即跳转 |
| 音量滑杆 | 0-100% 精确音量（新增 UI，走 `set_volume`），拖动 150ms 合并一次命令 |
| 播放状态即时显示 | 连接/配对完成后立刻拉一次状态，不用等扩展 2 秒一轮的推送 |
| PWA 图标 | 补齐 `icon.svg` / `icon-192.png` / `icon-512.png`（含 maskable），"添加到主屏幕"有正常图标，Chrome 也可安装 |
| 局域网地址优选 | 托盘/控制台把有默认网关的真实网卡地址排在最前，Hyper-V/WSL/VMware 等虚拟网卡地址排后，避免手机连到连不通的地址 |
| 配对码防爆破 | 同一客户端连续输错 5 次配对码，锁定 60 秒（Token 认证不受影响） |
