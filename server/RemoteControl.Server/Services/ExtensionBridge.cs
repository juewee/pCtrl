using System.Collections.Concurrent;
using System.Net;
using System.Net.WebSockets;
using System.Text.Json;
using System.Text.Json.Nodes;
using RemoteControl.Server.Models;

namespace RemoteControl.Server.Services;

/// <summary>
/// 浏览器扩展桥接：在 127.0.0.1:8972 上监听扩展的 WebSocket 连接。
/// 电脑端向扩展下发 command，扩展返回 response；扩展主动推送 event（播放状态等）。
///
/// 稳定性设计：
///  - 所有下行消息串行发送（同一 WebSocket 不允许并发 SendAsync，否则会抛
///    InvalidOperationException 并被上层当成"扩展未连接或无响应"）。
///  - 扩展每 15s 发一次心跳，这里记录 lastSeen；超时即判定连接失效并主动断开，
///    让扩展尽快重连（避免"半开连接"长时间显示已连接却发不出命令）。
///  - 上下线事件按边沿触发：扩展快速重连时手机端不会看到"断线→连接"的抖动。
/// </summary>
public class ExtensionBridge : IDisposable
{
    /// <summary>超过该时长没有收到任何扩展消息，判定连接已失效</summary>
    private static readonly TimeSpan LivenessTimeout = TimeSpan.FromSeconds(60);
    private static readonly TimeSpan WatchdogInterval = TimeSpan.FromSeconds(10);
    /// <summary>空闲超过该时长主动发一次 ping，探测半开连接</summary>
    private static readonly TimeSpan IdlePingAfter = TimeSpan.FromSeconds(25);

    private readonly int _port;
    private HttpListener? _listener;
    private volatile WebSocket? _ext;
    private readonly SemaphoreSlim _sendGate = new(1, 1);
    private readonly ConcurrentDictionary<string, TaskCompletionSource<JsonNode?>> _pending = new();
    private long _lastSeenTicks = DateTime.UtcNow.Ticks;
    private int _reportedConnected; // 上报给手机端的连接状态（0/1），用于边沿触发

    public bool IsConnected
    {
        get
        {
            var ws = _ext;
            return ws is { State: WebSocketState.Open } && DateTime.UtcNow - LastSeenUtc < LivenessTimeout;
        }
    }

    /// <summary>距上次收到扩展消息的秒数（诊断用）</summary>
    public double IdleSeconds => (DateTime.UtcNow - LastSeenUtc).TotalSeconds;

    public event Action<Envelope>? EventReceived;

    public ExtensionBridge(int port) => _port = port;

    private DateTime LastSeenUtc => new(Interlocked.Read(ref _lastSeenTicks), DateTimeKind.Utc);

    public async Task StartAsync(CancellationToken ct)
    {
        _listener = new HttpListener();
        _listener.Prefixes.Add($"http://127.0.0.1:{_port}/");
        try
        {
            _listener.Start();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[ExtensionBridge] 端口 {_port} 监听失败：{ex.Message}");
            return;
        }
        Console.WriteLine($"[ExtensionBridge] 等待浏览器扩展连接：ws://127.0.0.1:{_port}");

        _ = Task.Run(() => WatchdogAsync(ct));

        while (!ct.IsCancellationRequested)
        {
            HttpListenerContext ctx;
            try
            {
                ctx = await _listener.GetContextAsync();
            }
            catch
            {
                break;
            }

            if (!ctx.Request.IsWebSocketRequest)
            {
                ctx.Response.StatusCode = 400;
                ctx.Response.Close();
                continue;
            }

            HttpListenerWebSocketContext wsCtx;
            try
            {
                wsCtx = await ctx.AcceptWebSocketAsync(subProtocol: null);
            }
            catch
            {
                continue;
            }

            var old = _ext;
            _ext = wsCtx.WebSocket;
            Interlocked.Exchange(ref _lastSeenTicks, DateTime.UtcNow.Ticks);
            if (old != null)
            {
                try { old.Abort(); } catch { }
            }

            ReportState(true);
            _ = Task.Run(() => ReceiveLoopAsync(wsCtx.WebSocket, ct));
        }
    }

    private async Task ReceiveLoopAsync(WebSocket ws, CancellationToken ct)
    {
        var buffer = new byte[32 * 1024];
        try
        {
            while (ws.State == WebSocketState.Open && !ct.IsCancellationRequested)
            {
                using var ms = new MemoryStream();
                WebSocketReceiveResult r;
                do
                {
                    r = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), ct);
                    if (r.MessageType == WebSocketMessageType.Close) break;
                    ms.Write(buffer, 0, r.Count);
                } while (!r.EndOfMessage);

                if (r.MessageType == WebSocketMessageType.Close) break;

                // 任何一条消息都算"活着"（心跳、播放状态、命令响应）
                Interlocked.Exchange(ref _lastSeenTicks, DateTime.UtcNow.Ticks);

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

                if (env.Type == "response" && env.Id != null &&
                    _pending.TryRemove(env.Id, out var tcs))
                {
                    tcs.TrySetResult(env.Payload);
                }
                else if (env.Type == "event")
                {
                    // 心跳只用于保活/探活，不转发给手机端
                    if (string.Equals(env.Action, "heartbeat", StringComparison.OrdinalIgnoreCase)) continue;
                    EventReceived?.Invoke(env);
                }
            }
        }
        catch (OperationCanceledException) { }
        catch (Exception ex)
        {
            Console.WriteLine($"[ExtensionBridge] 连接异常：{ex.Message}");
        }
        finally
        {
            if (ReferenceEquals(_ext, ws))
            {
                _ext = null;
                ReportState(false);
            }
            try { ws.Abort(); } catch { }
        }
    }

    /// <summary>看门狗：探测半开连接，必要时主动断开让扩展重连</summary>
    private async Task WatchdogAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try { await Task.Delay(WatchdogInterval, ct); }
            catch (OperationCanceledException) { break; }

            var ws = _ext;
            if (ws == null || ws.State != WebSocketState.Open) continue;

            var idle = DateTime.UtcNow - LastSeenUtc;
            if (idle >= LivenessTimeout)
            {
                Console.WriteLine($"[ExtensionBridge] 扩展 {idle.TotalSeconds:F0}s 无消息，判定连接失效，等待扩展重连");
                try { ws.Abort(); } catch { }
                continue;
            }
            if (idle >= IdlePingAfter)
            {
                try { await SendAsync("ping", null, TimeSpan.FromSeconds(5), ct); }
                catch { /* 无响应交给看门狗超时处理 */ }
            }
        }
    }

    /// <summary>边沿触发地上报扩展上下线，避免快速重连时手机端状态抖动</summary>
    private void ReportState(bool connected)
    {
        var flag = connected ? 1 : 0;
        if (Interlocked.Exchange(ref _reportedConnected, flag) == flag) return;
        EventReceived?.Invoke(new Envelope
        {
            Type = "event",
            Action = connected ? "extension_connected" : "extension_disconnected",
            Payload = JsonHelpers.ToNode(new { })
        });
    }

    /// <summary>向扩展发送命令并等待响应；超时或未连接时抛出异常</summary>
    public async Task<JsonNode?> SendAsync(string action, JsonNode? payload, TimeSpan timeout, CancellationToken ct = default)
    {
        var ws = _ext;
        if (ws == null || ws.State != WebSocketState.Open)
            throw new InvalidOperationException("浏览器扩展未连接");

        var id = Guid.NewGuid().ToString("N");
        var tcs = new TaskCompletionSource<JsonNode?>(TaskCreationOptions.RunContinuationsAsynchronously);
        _pending[id] = tcs;

        var env = new Envelope { Id = id, Type = "command", Action = action, Payload = payload };
        try
        {
            var bytes = JsonSerializer.SerializeToUtf8Bytes(env, JsonOptions.Default);

            // 同一 WebSocket 上并发 SendAsync 会抛异常，这里串行化
            await _sendGate.WaitAsync(ct);
            try
            {
                if (ws.State != WebSocketState.Open)
                    throw new InvalidOperationException("浏览器扩展连接已关闭");
                await ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, ct);
            }
            finally
            {
                _sendGate.Release();
            }

            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(timeout);
            using (cts.Token.Register(() => tcs.TrySetCanceled()))
            {
                return await tcs.Task;
            }
        }
        finally
        {
            _pending.TryRemove(id, out _);
        }
    }

    public void Dispose()
    {
        try { _listener?.Stop(); } catch { }
        try { _ext?.Abort(); } catch { }
    }
}
