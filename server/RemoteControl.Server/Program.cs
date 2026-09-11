using System.Net.WebSockets;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using RemoteControl.Server.Services;
using System.Windows.Forms;

Application.EnableVisualStyles();
Application.SetCompatibleTextRenderingDefault(false);

var headless = args.Contains("--no-tray");

// ---------- 组装服务 ----------
var configService = new ConfigService();
var config = configService.Get();

var input = new InputSimulatorService();
var recorder = new MacroRecorder(input);
var macroService = new MacroService(configService, input, recorder);
var bridge = new ExtensionBridge(config.ExtensionPort);
var sessions = new RemoteSessionManager();
var ai = new AiService(configService);
var dispatcher = new CommandDispatcher(configService, sessions, input, macroService, bridge, ai);

// 扩展主动推送的事件（播放状态、上下线）广播给所有手机端
bridge.EventReceived += async env =>
{
    try { await sessions.BroadcastAsync(env); }
    catch { }
};

// 手机端断开时释放仍按下的按键，避免电脑上方向键/修饰键一直按着（卡键）
sessions.SessionClosed += () =>
{
    try { input.ReleaseAll(); } catch { }
};

var cts = new CancellationTokenSource();
_ = Task.Run(() => bridge.StartAsync(cts.Token));

// ---------- Kestrel：静态页面 + /ws ----------
var app = BuildWebApp(config.Port, sessions, configService, dispatcher);
await app.StartAsync(cts.Token);

Console.WriteLine("[RemoteControl] ========================================");
Console.WriteLine($"[RemoteControl] 手机端服务：http://0.0.0.0:{config.Port}");
foreach (var ip in NetworkHelper.LocalIPv4())
    Console.WriteLine($"[RemoteControl]   手机访问 → http://{ip}:{config.Port}");
Console.WriteLine($"[RemoteControl] 扩展桥接：ws://127.0.0.1:{config.ExtensionPort}");
Console.WriteLine($"[RemoteControl] 配对码：{config.PairingCode}");
Console.WriteLine("[RemoteControl] ========================================");

if (headless)
{
    // 无托盘调试模式：--no-tray，按 Q 或 Ctrl+C 退出
    Console.WriteLine("[RemoteControl] --no-tray 模式运行中（宏录制不可用），按 Q 退出...");
    var done = new TaskCompletionSource();
    Console.CancelKeyPress += (_, e) =>
    {
        e.Cancel = true;
        done.TrySetResult();
    };
    // stdin 被重定向（后台运行/服务托管）时无法读键，仅等待 Ctrl+C 或进程终止
    if (!Console.IsInputRedirected)
    {
        _ = Task.Run(async () =>
        {
            try
            {
                while (!done.Task.IsCompleted)
                {
                    if (Console.KeyAvailable && Console.ReadKey(intercept: true).Key == ConsoleKey.Q)
                        break;
                    await Task.Delay(100);
                }
            }
            catch { }
            done.TrySetResult();
        });
    }
    await done.Task;
}
else
{
    // 全局钩子必须在 UI 线程安装（需要消息循环）
    recorder.Install();
    using var tray = new TrayIconService(configService, macroService, () =>
    {
        cts.Cancel();
        Application.Exit();
    });
    Application.Run();
}

try { await app.StopAsync(cts.Token); } catch { }
bridge.Dispose();
Console.WriteLine("[RemoteControl] 已退出。");

// ---------- Web 宿主 ----------
static WebApplication BuildWebApp(int port, RemoteSessionManager sessions,
    ConfigService configService, CommandDispatcher dispatcher)
{
    // 内容根固定为 exe 所在目录：双击运行/开机自启时工作目录可能是任意路径，
    // 不固定会导致 wwwroot 静态文件 404（手机端打不开页面）
    var builder = WebApplication.CreateBuilder(new WebApplicationOptions
    {
        ContentRootPath = AppContext.BaseDirectory,
        WebRootPath = Path.Combine(AppContext.BaseDirectory, "wwwroot")
    });
    builder.WebHost.UseUrls($"http://0.0.0.0:{port}");

    var app = builder.Build();

    app.UseWebSockets(new WebSocketOptions
    {
        KeepAliveInterval = TimeSpan.FromSeconds(30)
    });

    app.UseDefaultFiles();
    app.UseStaticFiles();

    app.Use(async (context, next) =>
    {
        if (context.Request.Path == "/ws" && context.WebSockets.IsWebSocketRequest)
        {
            var ws = await context.WebSockets.AcceptWebSocketAsync();
            try
            {
                await sessions.HandleConnectionAsync(ws, configService, dispatcher, context.RequestAborted,
                    context.Connection.RemoteIpAddress?.ToString());
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[WS] 连接处理异常：{ex.Message}");
            }
            finally
            {
                try { ws.Dispose(); } catch { }
            }
        }
        else
        {
            await next();
        }
    });

    return app;
}
