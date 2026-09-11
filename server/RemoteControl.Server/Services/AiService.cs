using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using RemoteControl.Server.Models;

namespace RemoteControl.Server.Services;

public class AiResult
{
    public string Reply { get; set; } = "";
    public List<string> Executed { get; set; } = new();
}

/// <summary>
/// AI 模块：将自然语言解析为白名单命令并执行。
/// 配置 provider=openai 时调用 OpenAI 兼容接口（OpenAI / 本地 Ollama 等）；
/// 未配置或调用失败时回退到内置中文规则解析，保证开箱可用。
/// </summary>
public class AiService
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(25) };

    /// <summary>AI 允许生成的命令白名单</summary>
    private static readonly HashSet<string> Allowed = new(StringComparer.OrdinalIgnoreCase)
    {
        "play_pause", "play", "pause",
        "next_episode", "prev_episode",
        "seek_forward", "seek_backward",
        "volume_up", "volume_down", "set_volume",
        "mute", "fullscreen",
        "browser_action", "macro_execute", "key_press"
    };

    private readonly ConfigService _config;

    public AiService(ConfigService config) => _config = config;

    public async Task<AiResult> ProcessAsync(string text, string macroCatalog,
        Func<string, JsonNode?, Task> execAsync, CancellationToken ct = default)
    {
        var cfg = _config.Get().Ai;
        if (string.Equals(cfg.Provider, "openai", StringComparison.OrdinalIgnoreCase) &&
            !string.IsNullOrWhiteSpace(cfg.Model))
        {
            try
            {
                return await CallLlmAsync(cfg, text, macroCatalog, execAsync, ct);
            }
            catch (Exception ex)
            {
                var local = await LocalParseAsync(text, execAsync);
                local.Reply = $"AI 服务调用失败（{ex.Message}），已按内置规则执行：{local.Reply}";
                return local;
            }
        }
        return await LocalParseAsync(text, execAsync);
    }

    #region LLM 调用

    private static async Task<AiResult> CallLlmAsync(AiConfig cfg, string text, string macroCatalog,
        Func<string, JsonNode?, Task> execAsync, CancellationToken ct)
    {
        var system = $$$"""
            你是一个电脑遥控器助手。根据用户的中文自然语言指令，输出要执行的遥控命令。
            只允许使用以下动作（action）：
            - play_pause / play / pause：播放或暂停
            - next_episode / prev_episode：下一集 / 上一集
            - seek_forward：快进，payload {"seconds": 秒数}
            - seek_backward：快退，payload {"seconds": 秒数}
            - volume_up / volume_down：音量加 / 音量减
            - set_volume：设置音量，payload {"value": 0到1之间的小数}
            - mute：静音切换
            - fullscreen：全屏切换
            - browser_action：浏览器操作，payload 为 {"action":"open_url","payload":{"url":"..."}}
              或 {"action":"search","payload":{"query":"..."}}
            - macro_execute：执行宏，payload {"macro_id":"宏ID"}
            - key_press：按键，payload {"key":"按键名"}
            可用宏列表（id=名称）：{{{macroCatalog}}}
            必须只输出一个 JSON 对象，格式：
            {"reply":"给用户的简短中文回复","commands":[{"action":"...","payload":{}}]}
            无法理解时 commands 返回空数组，并在 reply 中说明。
            """;

        var url = cfg.BaseUrl.TrimEnd('/') + "/chat/completions";
        using var req = new HttpRequestMessage(HttpMethod.Post, url);
        if (!string.IsNullOrWhiteSpace(cfg.ApiKey))
            req.Headers.TryAddWithoutValidation("Authorization", "Bearer " + cfg.ApiKey.Trim());

        var body = new
        {
            model = cfg.Model,
            temperature = 0.2,
            response_format = new { type = "json_object" },
            messages = new object[]
            {
                new { role = "system", content = system },
                new { role = "user", content = text }
            }
        };
        req.Content = new StringContent(JsonSerializer.Serialize(body, JsonOptions.Default), Encoding.UTF8, "application/json");

        using var resp = await Http.SendAsync(req, ct);
        resp.EnsureSuccessStatusCode();

        var root = JsonNode.Parse(await resp.Content.ReadAsStringAsync(ct));
        var content = root?["choices"]?[0]?["message"]?["content"]?.GetValue<string>() ?? "{}";
        var match = Regex.Match(content, @"\{.*\}", RegexOptions.Singleline);
        var parsed = JsonNode.Parse(match.Success ? match.Value : content) ?? new JsonObject();

        var result = new AiResult
        {
            Reply = parsed["reply"]?.GetValue<string>() ?? "已执行"
        };

        if (parsed["commands"] is JsonArray arr)
        {
            foreach (var c in arr)
            {
                var action = c?["action"]?.GetValue<string>();
                if (string.IsNullOrEmpty(action) || !Allowed.Contains(action))
                    continue;
                await execAsync(action!, c!["payload"]);
                result.Executed.Add(action!);
            }
        }

        if (result.Executed.Count == 0 && result.Reply == "已执行")
            result.Reply = "抱歉，我没有理解这条指令。可以试试：播放/暂停、下一集、音量调到50%、打开B站、搜索周杰伦。";

        return result;
    }

    #endregion

    #region 内置中文规则解析（回退方案）

    private static async Task<AiResult> LocalParseAsync(string text, Func<string, JsonNode?, Task> execAsync)
    {
        var commands = new List<(string action, JsonNode? payload, string desc)>();
        void Add(string action, object? payload, string desc) =>
            commands.Add((action, payload == null ? null : JsonHelpers.ToNode(payload), desc));

        var t = text;

        // 音量百分比
        var volMatch = Regex.Match(t, @"音量.*?(\d{1,3})\s*[%％]");
        if (volMatch.Success)
        {
            var v = Math.Clamp(int.Parse(volMatch.Groups[1].Value), 0, 100) / 100.0;
            Add("set_volume", new { value = v }, $"音量调到 {(int)(v * 100)}%");
        }
        else if (Regex.IsMatch(t, @"((音量|声音).*(大|高|加|升|响))|大声点"))
            Add("volume_up", null, "音量调大");
        else if (Regex.IsMatch(t, @"((音量|声音).*(小|低|减|降|轻))|小声点"))
            Add("volume_down", null, "音量调小");

        if (t.Contains("静音")) Add("mute", null, "静音切换");
        if (Regex.IsMatch(t, @"下一集|下一个|切一集")) Add("next_episode", null, "下一集");
        if (Regex.IsMatch(t, @"上一集|上一个")) Add("prev_episode", null, "上一集");

        if (Regex.IsMatch(t, @"快进|前进|往后|向后"))
        {
            var s = ParseSeconds(t, 10);
            Add("seek_forward", new { seconds = s }, $"快进 {s} 秒");
        }
        if (Regex.IsMatch(t, @"快退|后退|回退|往前|向前"))
        {
            var s = ParseSeconds(t, 10);
            Add("seek_backward", new { seconds = s }, $"快退 {s} 秒");
        }

        if (t.Contains("全屏")) Add("fullscreen", null, "全屏切换");

        if (Regex.IsMatch(t, @"暂停|停下")) Add("pause", null, "暂停");
        else if (Regex.IsMatch(t, @"播放|继续|开始放")) Add("play", null, "播放");

        // 打开网址
        var urlMatch = Regex.Match(t, @"打开\s*(https?://\S+)", RegexOptions.IgnoreCase);
        if (urlMatch.Success)
        {
            var url = urlMatch.Groups[1].Value.TrimEnd('/', '。', '，', ',', '.');
            Add("browser_action", new { action = "open_url", payload = new { url } }, "打开网址");
        }
        else
        {
            if (Regex.IsMatch(t, @"打开.*?(b站|哔哩|bilibili)", RegexOptions.IgnoreCase))
                Add("browser_action", new { action = "open_url", payload = new { url = "https://www.bilibili.com" } }, "打开 B 站");
            if (Regex.IsMatch(t, @"打开.*?(youtube|油管)", RegexOptions.IgnoreCase))
                Add("browser_action", new { action = "open_url", payload = new { url = "https://www.youtube.com" } }, "打开 YouTube");
        }

        var searchMatch = Regex.Match(t, @"搜索\s*([^\s,，。]+.*)$");
        if (searchMatch.Success)
        {
            var q = searchMatch.Groups[1].Value.Trim();
            if (q.Length > 0)
                Add("browser_action", new { action = "search", payload = new { query = q } }, $"搜索「{q}」");
        }

        var result = new AiResult();
        foreach (var (action, payload, _) in commands)
        {
            await execAsync(action, payload);
            result.Executed.Add(action);
        }

        result.Reply = commands.Count > 0
            ? "已执行：" + string.Join("、", commands.Select(c => c.desc))
            : "抱歉，我没有理解这条指令。可以试试：播放/暂停、下一集、音量调到50%、打开B站、搜索周杰伦。";

        return result;
    }

    private static int ParseSeconds(string t, int fallback)
    {
        var m = Regex.Match(t, @"(\d+)\s*秒");
        return m.Success && int.TryParse(m.Groups[1].Value, out var s) ? Math.Clamp(s, 1, 3600) : fallback;
    }

    #endregion
}
