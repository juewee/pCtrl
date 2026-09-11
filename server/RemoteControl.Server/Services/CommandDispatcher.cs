using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using RemoteControl.Server.Models;

namespace RemoteControl.Server.Services;

/// <summary>命令分发器：校验并执行手机端发来的所有 command</summary>
public class CommandDispatcher
{
    private readonly ConfigService _config;
    private readonly RemoteSessionManager _sessions;
    private readonly InputSimulatorService _input;
    private readonly MacroService _macros;
    private readonly ExtensionBridge _bridge;
    private readonly AiService _ai;

    /// <summary>允许转发给浏览器扩展的动作白名单</summary>
    private static readonly HashSet<string> BrowserActions = new(StringComparer.OrdinalIgnoreCase)
    {
        "play", "pause", "play_pause", "seek", "volume", "mute", "fullscreen",
        "next_episode", "prev_episode", "open_url", "search", "click", "get_status",
        "speed_start", "speed_stop", "tv_nav", "refresh_feed",
        "next_tab", "prev_tab",
        "inspect"
    };

    public CommandDispatcher(ConfigService config, RemoteSessionManager sessions,
        InputSimulatorService input, MacroService macros, ExtensionBridge bridge, AiService ai)
    {
        _config = config;
        _sessions = sessions;
        _input = input;
        _macros = macros;
        _bridge = bridge;
        _ai = ai;

        // 宏步骤中的 browser_action 复用媒体路由（扩展优先，模拟按键回退）
        _macros.MediaActionAsync = ExecuteMediaActionAsync;
    }

    public async Task<object?> GetInfoAsync(CancellationToken ct)
    {
        var cfg = _config.Get();
        return new
        {
            deviceName = cfg.DeviceName,
            version = "1.0.0",
            extensionConnected = _bridge.IsConnected,
            extensionIdleSeconds = Math.Round(_bridge.IdleSeconds, 1),
            aiProvider = cfg.Ai.Provider,
            aiModel = cfg.Ai.Model,
            port = cfg.Port
        };
    }

    /// <summary>主动向扩展查询一次播放状态并广播</summary>
    public async Task RefreshStatusAsync()
    {
        try
        {
            var st = await _bridge.SendAsync("get_status", null, TimeSpan.FromSeconds(1), CancellationToken.None);
            if (st != null)
                await _sessions.BroadcastAsync(new Envelope { Type = "event", Action = "playback_state", Payload = st });
        }
        catch
        {
            // 扩展未连接时忽略
        }
    }

    public async Task<(object? result, string? error)> DispatchAsync(Envelope env, CancellationToken ct)
    {
        switch (env.Action)
        {
            case "ping":
                return (new { pong = true }, null);

            case "get_info":
                return (await GetInfoAsync(ct), null);

            case "get_status":
            {
                object? status = null;
                try
                {
                    if (_bridge.IsConnected)
                    {
                        var res = await _bridge.SendAsync("get_status", null, TimeSpan.FromSeconds(1), ct);
                        if (res?["ok"]?.GetValue<bool>() == true) status = res;
                    }
                }
                catch
                {
                    // 扩展未连接时返回 status=false
                }
                return (status ?? new { status = false }, null);
            }

            // 媒体控制：扩展优先，模拟按键回退
            case "play_pause":
            case "play":
            case "pause":
            case "next_episode":
            case "prev_episode":
            case "seek_forward":
            case "seek_backward":
            case "volume_up":
            case "volume_down":
            case "set_volume":
            case "mute":
                await ExecuteMediaActionAsync(env.Action!, env.Payload, ct);
                return (new { ok = true }, null);

            // 全屏：把扩展的判定结果透传给手机端（知道这次是"进入"还是"退出"）；
            // 扩展超时时不再补发物理 F 键——否则会和扩展正在执行的动作互相打架，
            // 表现为"取消全屏后马上又全屏"。
            case "fullscreen":
            {
                var ext = await CallExtensionAsync("fullscreen", null, TimeSpan.FromSeconds(2.5), ct);
                if (ext.Outcome == ExtOutcome.Ok) return (ext.Payload, null);
                if (ext.Outcome == ExtOutcome.TimedOut)
                    return (new { ok = false, error = "浏览器扩展无响应，请稍后再试" }, null);
                _input.SendKey("f"); // 扩展不在线或无法处理：物理 F 键兜底
                return (new { ok = true, via = "key" }, null);
            }

            // 打开网址：扩展在线 → 在浏览器当前标签打开；扩展离线（电脑上没开浏览器）
            // → 由电脑端直接启动默认浏览器。手机端"OK 键"在无浏览器可控时用它打开 B 站。
            case "browser_open":
            {
                var url = env.Payload.Val<string>("url");
                if (string.IsNullOrWhiteSpace(url)) return (null, "缺少 url");
                if (!IsHttpUrl(url)) return (null, "只允许 http/https 地址");

                var ext = await CallExtensionAsync("open_url",
                    JsonHelpers.ToNode(new { url, newTab = false }), TimeSpan.FromSeconds(2), ct);
                if (ext.Outcome == ExtOutcome.Ok) return (new { ok = true, via = "extension" }, null);
                if (ext.Outcome == ExtOutcome.Failed) return (ext.Payload, null);

                LaunchDefaultBrowser(url);
                return (new { ok = true, via = "shell" }, null);
            }

            // 拖动进度条跳转（绝对定位；扩展离线时没有按键兜底）
            case "seek_to":
            {
                var t = env.Payload.Val<double?>("time");
                if (t.HasValue)
                {
                    await CallExtensionAsync("seek", JsonHelpers.ToNode(new { time = Math.Max(0, t.Value) }),
                        TimeSpan.FromSeconds(2), ct);
                }
                return (new { ok = true }, null);
            }

            case "mouse_move":
            {
                var dx = Math.Clamp(env.Payload.Val<int>("dx"), -800, 800);
                var dy = Math.Clamp(env.Payload.Val<int>("dy"), -800, 800);
                _input.MouseMove(dx, dy);
                return (null, null);
            }

            case "mouse_click":
                _input.MouseClick(env.Payload.Val<string>("button") ?? "left");
                return (null, null);

            case "scroll":
            {
                var dy = Math.Clamp(env.Payload.Val<int>("dy"), -50, 50);
                var dx = Math.Clamp(env.Payload.Val<int>("dx"), -50, 50);
                _input.Scroll(dy, dx);
                return (null, null);
            }

            case "key_press":
            {
                var key = env.Payload.Val<string>("key");
                if (string.IsNullOrWhiteSpace(key)) return (null, "缺少 key");
                var mods = env.Payload?["modifiers"]?.AsArray()
                    .Select(n => n?.GetValue<string>())
                    .Where(s => !string.IsNullOrEmpty(s))
                    .ToArray() ?? Array.Empty<string?>();
                _input.SendKey(key, mods);
                return (new { ok = true }, null);
            }

            case "key_down":
            {
                var key = env.Payload.Val<string>("key");
                if (string.IsNullOrWhiteSpace(key)) return (null, "缺少 key");
                return _input.KeyDown(key) ? (new { ok = true }, null) : (null, (string?)"无法识别按键");
            }

            case "key_up":
            {
                var key = env.Payload.Val<string>("key");
                if (string.IsNullOrWhiteSpace(key)) return (null, "缺少 key");
                _input.KeyUp(key);
                return (new { ok = true }, null);
            }

            case "key_combo":
            {
                var keys = env.Payload?["keys"]?.AsArray()
                    .Select(n => n?.GetValue<string>())
                    .Where(s => !string.IsNullOrWhiteSpace(s))
                    .ToArray() ?? Array.Empty<string?>();
                if (keys.Length == 0) return (null, "缺少 keys");
                if (keys.Length == 1)
                    _input.SendKey(keys[0]!);
                else
                    _input.SendKey(keys[^1]!, keys.Take(keys.Length - 1)!);
                return (new { ok = true }, null);
            }

            case "text_type":
            {
                var text = env.Payload.Val<string>("text");
                if (string.IsNullOrEmpty(text)) return (null, "缺少 text");
                if (text.Length > 500) text = text[..500];
                _input.SendText(text);
                return (new { ok = true }, null);
            }

            case "browser_action":
            {
                var action = env.Payload.Val<string>("action");
                if (action == null || !BrowserActions.Contains(action))
                    return (null, "不支持的浏览器动作");
                var inner = env.Payload?["payload"];
                var ext = await CallExtensionAsync(action, inner, TimeSpan.FromSeconds(3), ct);
                if (ext.Outcome is ExtOutcome.Ok or ExtOutcome.Failed)
                    return (new { result = ext.Payload }, null);
                return (null, ext.Outcome == ExtOutcome.TimedOut
                    ? "浏览器扩展无响应，请稍后重试"
                    : "浏览器扩展未连接");
            }

            case "macro_list":
                return (new
                {
                    macros = _macros.All.Select(m => new
                    {
                        id = m.Id,
                        name = m.Name,
                        steps = m.Steps.Count,
                        loop = m.Loop
                    })
                }, null);

            case "macro_execute":
            {
                var id = env.Payload.Val<string>("macro_id") ?? env.Payload.Val<string>("id");
                if (id == null) return (null, "缺少 macro_id");
                var macro = _macros.Find(id);
                if (macro == null) return (null, "宏不存在");

                var mid = macro.Id;
                var name = macro.Name;
                _ = Task.Run(async () =>
                {
                    var (ok, err) = await _macros.ExecuteAsync(mid, CancellationToken.None);
                    await _sessions.BroadcastAsync(new Envelope
                    {
                        Type = "event",
                        Action = "macro_finished",
                        Payload = JsonHelpers.ToNode(new { macro_id = mid, name, ok, error = err })
                    });
                });
                return (new { started = true, name }, null);
            }

            case "macro_save":
            {
                MacroDefinition? macro;
                try
                {
                    macro = env.Payload?.Deserialize<MacroDefinition>(JsonOptions.Default);
                }
                catch
                {
                    return (null, "宏格式错误");
                }
                if (macro == null || string.IsNullOrWhiteSpace(macro.Name))
                    return (null, "缺少宏名称");
                var saved = _macros.Upsert(macro);
                return (new { macro = new { id = saved.Id, name = saved.Name, steps = saved.Steps.Count } }, null);
            }

            case "macro_delete":
            {
                var id = env.Payload.Val<string>("macro_id") ?? env.Payload.Val<string>("id");
                if (id == null) return (null, "缺少 macro_id");
                return (new { ok = _macros.Delete(id) }, null);
            }

            case "macro_record_start":
                if (!_macros.StartRecording())
                    return (null, "录制功能不可用（需以托盘模式在本机运行）");
                await BroadcastRecording(true);
                return (new { recording = true }, null);

            case "macro_record_stop":
            {
                var macro = _macros.StopRecording();
                await BroadcastRecording(false);
                if (macro == null) return (null, "当前没有正在录制的宏");
                return (new
                {
                    macro = new
                    {
                        id = macro.Id,
                        name = macro.Name,
                        steps = macro.Steps
                    }
                }, null);
            }

            case "macro_record_cancel":
                _macros.CancelRecording();
                await BroadcastRecording(false);
                return (new { ok = true }, null);

            case "ai_query":
            {
                var text = env.Payload.Val<string>("text");
                if (string.IsNullOrWhiteSpace(text)) return (null, "缺少指令内容");
                var catalog = string.Join("; ", _macros.All.Select(m => $"{m.Id}={m.Name}"));
                var result = await _ai.ProcessAsync(text, catalog,
                    (action, payload) => ExecuteMediaActionAsync(action, payload, CancellationToken.None), ct);
                return (new { reply = result.Reply, executed = result.Executed }, null);
            }

            default:
                return (null, $"未知命令：{env.Action}");
        }
    }

    private async Task BroadcastRecording(bool recording)
    {
        await _sessions.BroadcastAsync(new Envelope
        {
            Type = "event",
            Action = "macro_recording",
            Payload = JsonHelpers.ToNode(new { recording })
        });
    }

    /// <summary>只允许 http/https，避免被当成命令行参数执行</summary>
    private static bool IsHttpUrl(string url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var u) &&
        (u.Scheme == Uri.UriSchemeHttp || u.Scheme == Uri.UriSchemeHttps);

    /// <summary>用默认浏览器打开网址（浏览器没运行时由系统启动）</summary>
    private static void LaunchDefaultBrowser(string url)
    {
        try
        {
            Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[RemoteControl] 启动默认浏览器失败：{ex.Message}");
        }
    }

    /// <summary>扩展动作的调用结果：区分"没连上/明确失败/超时没回应/成功"</summary>
    private enum ExtOutcome { NotConnected, Failed, TimedOut, Ok }

    private readonly record struct ExtResult(ExtOutcome Outcome, JsonNode? Payload);

    /// <summary>
    /// 调用扩展并区分结果。超时单独归类很关键：超时说明扩展可能正在执行该动作，
    /// 此时再补发模拟按键就会"做两次"（全屏最明显：取消后马上又全屏）。
    /// </summary>
    private async Task<ExtResult> CallExtensionAsync(string action, JsonNode? payload, TimeSpan timeout, CancellationToken ct)
    {
        if (!_bridge.IsConnected) return new ExtResult(ExtOutcome.NotConnected, null);
        try
        {
            var res = await _bridge.SendAsync(action, payload, timeout, ct);
            if (res == null) return new ExtResult(ExtOutcome.Failed, null);
            var ok = res["ok"]?.GetValue<bool>() ?? false;
            return new ExtResult(ok ? ExtOutcome.Ok : ExtOutcome.Failed, res);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (OperationCanceledException)
        {
            return new ExtResult(ExtOutcome.TimedOut, null);
        }
        catch
        {
            return new ExtResult(ExtOutcome.NotConnected, null);
        }
    }

    private async Task<ExtOutcome> TryExtensionAsync(string action, JsonNode? payload, CancellationToken ct) =>
        (await CallExtensionAsync(action, payload, TimeSpan.FromMilliseconds(1500), ct)).Outcome;

    /// <summary>开关型动作（播放/暂停、静音、全屏）：扩展超时时不补按键，避免切换两次</summary>
    private async Task ToggleViaExtensionAsync(string action, JsonNode? payload, VirtualKey fallback, CancellationToken ct)
    {
        var outcome = await TryExtensionAsync(action, payload, ct);
        if (outcome is ExtOutcome.Ok or ExtOutcome.TimedOut) return;
        _input.Tap(fallback);
    }

    /// <summary>非开关型动作（切集、快进、音量）：扩展没成功就补一次按键，重发无副作用</summary>
    private async Task FireViaExtensionOrKeyAsync(string action, JsonNode? payload, VirtualKey fallback, CancellationToken ct)
    {
        if (await TryExtensionAsync(action, payload, ct) == ExtOutcome.Ok) return;
        _input.Tap(fallback);
    }

    /// <summary>
    /// 媒体/浏览器动作路由：优先交给浏览器扩展精确控制，扩展不可用时回退为全局模拟按键。
    /// 同时供宏步骤与 AI 命令复用。
    /// </summary>
    public async Task ExecuteMediaActionAsync(string action, JsonNode? payload, CancellationToken ct = default)
    {
        switch (action)
        {
            case "play_pause":
                await ToggleViaExtensionAsync("play_pause", null, VirtualKey.Space, ct);
                break;

            case "play":
                await ToggleViaExtensionAsync("play", null, VirtualKey.Space, ct);
                break;

            case "pause":
                await ToggleViaExtensionAsync("pause", null, VirtualKey.Space, ct);
                break;

            case "next_episode":
                await FireViaExtensionOrKeyAsync("next_episode", null, VirtualKey.MediaNext, ct);
                break;

            case "prev_episode":
                await FireViaExtensionOrKeyAsync("prev_episode", null, VirtualKey.MediaPrev, ct);
                break;

            case "seek_forward":
            {
                var sec = payload.Val<double?>("seconds") ?? 10;
                await FireViaExtensionOrKeyAsync("seek", JsonHelpers.ToNode(new { delta = sec }), VirtualKey.Right, ct);
                break;
            }

            case "seek_backward":
            {
                var sec = payload.Val<double?>("seconds") ?? 10;
                await FireViaExtensionOrKeyAsync("seek", JsonHelpers.ToNode(new { delta = -sec }), VirtualKey.Left, ct);
                break;
            }

            case "volume_up":
                await FireViaExtensionOrKeyAsync("volume", JsonNode.Parse("""{"delta":0.1}"""), VirtualKey.VolumeUp, ct);
                break;

            case "volume_down":
                await FireViaExtensionOrKeyAsync("volume", JsonNode.Parse("""{"delta":-0.1}"""), VirtualKey.VolumeDown, ct);
                break;

            case "set_volume":
            {
                var v = payload.Val<double?>("value");
                if (v.HasValue)
                    await CallExtensionAsync("volume", JsonHelpers.ToNode(new { value = Math.Clamp(v.Value, 0, 1) }),
                        TimeSpan.FromMilliseconds(1500), ct);
                break;
            }

            case "mute":
                await ToggleViaExtensionAsync("mute", null, VirtualKey.VolumeMute, ct);
                break;

            case "fullscreen":
            {
                var outcome = await TryExtensionAsync("fullscreen", null, ct);
                if (outcome is ExtOutcome.Ok or ExtOutcome.TimedOut) break;
                _input.SendKey("f");
                break;
            }

            // AI / 宏中的 browser_action 包装：{action:"open_url", payload:{...}}
            case "browser_action":
            {
                var a = payload.Val<string>("action");
                if (a != null)
                {
                    var inner = payload?["payload"];
                    await CallExtensionAsync(a, inner, TimeSpan.FromSeconds(3), ct);
                }
                break;
            }

            case "macro_execute":
            {
                var id = payload.Val<string>("macro_id");
                if (id != null && _macros.Find(id) != null)
                    _ = Task.Run(() => _macros.ExecuteAsync(id, CancellationToken.None));
                break;
            }

            // 宏步骤可用的"扩展动作"直通（供"打开抖音推荐"等宏组合 open_url + click）
            case "open_url":
            case "search":
            case "click":
            case "refresh_feed":
            case "tv_nav":
            case "speed_start":
            case "speed_stop":
                await CallExtensionAsync(action, payload, TimeSpan.FromSeconds(3), ct);
                break;

            case "key_press":
                _input.SendKey(payload.Val<string>("key"));
                break;
        }
    }
}
