using System.Text.Json;
using System.Text.Json.Nodes;

namespace RemoteControl.Server.Models;

/// <summary>
/// WebSocket 消息信封（手机端 ↔ 电脑端 ↔ 浏览器扩展通用）
/// </summary>
public class Envelope
{
    public string? Id { get; set; }
    /// <summary>command | event | response | auth</summary>
    public string? Type { get; set; }
    public string? Action { get; set; }
    public JsonNode? Payload { get; set; }
    public long Timestamp { get; set; } = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
}

public static class JsonOptions
{
    public static readonly JsonSerializerOptions Default = new(JsonSerializerDefaults.Web);

    public static readonly JsonSerializerOptions Indented = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true
    };
}

/// <summary>JsonNode 取值辅助方法</summary>
public static class JsonHelpers
{
    public static T? Val<T>(this JsonNode? node, string key)
    {
        if (node is JsonObject obj && obj.TryGetPropertyValue(key, out var v) && v is JsonValue jv)
        {
            if (jv.TryGetValue<T>(out var r))
                return r;
            try
            {
                var target = Nullable.GetUnderlyingType(typeof(T)) ?? typeof(T);
                return (T?)Convert.ChangeType(jv.ToString(), target);
            }
            catch
            {
                return default;
            }
        }
        return default;
    }

    public static JsonNode ToNode(object? o) =>
        JsonNode.Parse(JsonSerializer.Serialize(o ?? new { }, JsonOptions.Default))!;
}
