using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text.Json;
using RemoteControl.Server.Models;

namespace RemoteControl.Server.Services;

/// <summary>手机端 WebSocket 连接管理：配对认证、消息分发、事件广播</summary>
public class RemoteSessionManager
{
    private readonly ConcurrentDictionary<WebSocket, ClientState> _clients = new();

    /// <summary>手机端会话断开时触发（用于释放仍按下的按键，避免"卡键"）</summary>
    public event Action? SessionClosed;

    /// <summary>配对码连续输错次数上限，超过则临时锁定该客户端</summary>
    private const int MaxAuthFailures = 5;
    private static readonly TimeSpan AuthLockout = TimeSpan.FromSeconds(60);
    private readonly ConcurrentDictionary<string, AuthAttempt> _authAttempts = new();

    private sealed class AuthAttempt
    {
        public int Failures;
        public DateTime LockedUntil = DateTime.MinValue;
    }

    /// <summary>向所有已认证的手机端广播事件</summary>
    public async Task BroadcastAsync(Envelope env)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(env, JsonOptions.Default);
        foreach (var (ws, st) in _clients)
        {
            if (ws.State != WebSocketState.Open) continue;
            await st.Gate.WaitAsync();
            try
            {
                if (ws.State == WebSocketState.Open)
                    await ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, CancellationToken.None);
            }
            catch
            {
                // 单个连接发送失败不影响其他连接
            }
            finally
            {
                st.Gate.Release();
            }
        }
    }

    public async Task HandleConnectionAsync(WebSocket ws, ConfigService config, CommandDispatcher dispatcher,
        CancellationToken ct, string? clientKey = null)
    {
        var state = new ClientState();
        await SendAsync(ws, state, new Envelope { Type = "event", Action = "auth_required" }, ct);

        var authed = false;
        var buffer = new byte[32 * 1024];

        try
        {
            while (ws.State == WebSocketState.Open && !ct.IsCancellationRequested)
            {
                using var ms = new MemoryStream();
                WebSocketReceiveResult result;
                do
                {
                    result = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), ct);
                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        try { await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "bye", ct); } catch { }
                        return;
                    }
                    ms.Write(buffer, 0, result.Count);
                } while (!result.EndOfMessage);

                Envelope? env;
                try
                {
                    env = JsonSerializer.Deserialize<Envelope>(ms.ToArray(), JsonOptions.Default);
                }
                catch
                {
                    continue;
                }
                if (env == null) continue;

                if (!authed)
                {
                    await HandleAuthAsync(ws, state, env, config, clientKey, success =>
                    {
                        authed = success;
                        if (success) _clients[ws] = state;
                    }, ct);
                    if (authed)
                    {
                        // 推送设备信息并向扩展请求一次最新状态
                        var info = await dispatcher.GetInfoAsync(ct);
                        await SendAsync(ws, state, new Envelope { Type = "event", Action = "info", Payload = JsonHelpers.ToNode(info) }, ct);
                        _ = dispatcher.RefreshStatusAsync();
                    }
                    continue;
                }

                // 高频消息限流：触摸板移动/滚动。手机端已按 ~33 条/秒合并发送，
                // 这里给到 60/秒的余量，避免正常滑动被丢包（丢包表现为鼠标"卡顿/断触"）。
                if ((env.Action == "mouse_move" || env.Action == "scroll") && !state.Rate.Allow())
                    continue;

                object? resultPayload;
                string? error;
                try
                {
                    (resultPayload, error) = await dispatcher.DispatchAsync(env, ct);
                }
                catch (Exception ex)
                {
                    error = ex.Message;
                    resultPayload = null;
                }

                if (!string.IsNullOrEmpty(env.Id))
                {
                    var resp = new Envelope
                    {
                        Id = env.Id,
                        Type = "response",
                        Action = env.Action,
                        Payload = error != null ? JsonHelpers.ToNode(new { error }) : JsonHelpers.ToNode(resultPayload ?? new { ok = true })
                    };
                    await SendAsync(ws, state, resp, ct);
                }
            }
        }
        catch (OperationCanceledException) { }
        catch (WebSocketException) { }
        catch (Exception ex)
        {
            Console.WriteLine($"[WS] 连接异常：{ex.Message}");
        }
        finally
        {
            _clients.TryRemove(ws, out _);
            try { ws.Abort(); } catch { }
            // 会话结束：释放该手机可能仍按着的按键（长按倍速后断线会一直按住方向键）
            try { SessionClosed?.Invoke(); } catch { }
        }
    }

    private async Task HandleAuthAsync(WebSocket ws, ClientState state, Envelope env, ConfigService config,
        string? clientKey, Action<bool> onResult, CancellationToken ct)
    {
        if (env.Type != "auth" && env.Action != "auth") return;

        var code = env.Payload.Val<string>("code");
        var token = env.Payload.Val<string>("token");
        var cfg = config.Get();

        // 只有"输配对码"才做限流；Token 是长随机串，不需要
        var key = clientKey ?? "local";
        if (!string.IsNullOrWhiteSpace(code))
        {
            var attempt = _authAttempts.GetOrAdd(key, _ => new AuthAttempt());
            var lockedFor = (attempt.LockedUntil - DateTime.UtcNow).TotalSeconds;
            if (lockedFor > 0)
            {
                await SendAsync(ws, state, new Envelope
                {
                    Type = "event",
                    Action = "auth_failed",
                    Payload = JsonHelpers.ToNode(new { error = $"尝试次数过多，请 {(int)Math.Ceiling(lockedFor)} 秒后再试" })
                }, ct);
                onResult(false);
                return;
            }
        }

        if (!string.IsNullOrWhiteSpace(code) && code.Trim() == cfg.PairingCode)
        {
            _authAttempts.TryRemove(key, out _);
            var newToken = Guid.NewGuid().ToString("N") + Guid.NewGuid().ToString("N")[..16];
            cfg.Token = newToken;
            config.Save(cfg);
            await SendAsync(ws, state, new Envelope
            {
                Id = env.Id,
                Type = "response",
                Action = "auth",
                Payload = JsonHelpers.ToNode(new { token = newToken, deviceName = cfg.DeviceName })
            }, ct);
            onResult(true);
        }
        else if (!string.IsNullOrWhiteSpace(token) && token == cfg.Token)
        {
            await SendAsync(ws, state, new Envelope
            {
                Id = env.Id,
                Type = "response",
                Action = "auth",
                Payload = JsonHelpers.ToNode(new { token, deviceName = cfg.DeviceName })
            }, ct);
            onResult(true);
        }
        else
        {
            var locked = false;
            if (!string.IsNullOrWhiteSpace(code))
            {
                var attempt = _authAttempts.GetOrAdd(key, _ => new AuthAttempt());
                if (Interlocked.Increment(ref attempt.Failures) >= MaxAuthFailures)
                {
                    attempt.LockedUntil = DateTime.UtcNow + AuthLockout;
                    attempt.Failures = 0;
                    locked = true;
                }
            }
            await SendAsync(ws, state, new Envelope
            {
                Type = "event",
                Action = "auth_failed",
                Payload = JsonHelpers.ToNode(new
                {
                    error = locked
                        ? $"配对码连续输错 {MaxAuthFailures} 次，请 {AuthLockout.TotalSeconds:0} 秒后再试"
                        : "配对码不正确，请重新输入"
                })
            }, ct);
            onResult(false);
        }
    }

    private static async Task SendAsync(WebSocket ws, ClientState state, Envelope env, CancellationToken ct)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(env, JsonOptions.Default);
        await state.Gate.WaitAsync(ct);
        try
        {
            if (ws.State == WebSocketState.Open)
                await ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, ct);
        }
        finally
        {
            state.Gate.Release();
        }
    }

    private class ClientState
    {
        public SemaphoreSlim Gate { get; } = new(1, 1);
        public TokenBucket Rate { get; } = new(60, 60);
    }
}
