using System.Text.Json.Nodes;

namespace RemoteControl.Server.Models;

/// <summary>宏定义（macros.json 中的一条记录）</summary>
public class MacroDefinition
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public List<MacroStep> Steps { get; set; } = new();
    public bool Loop { get; set; }
}

/// <summary>
/// 宏步骤。支持的 type：
/// key_press / key_combo / text_type / mouse_move / mouse_click / scroll /
/// delay / browser_action / execute_macro
/// </summary>
public class MacroStep
{
    public string Type { get; set; } = "";

    /// <summary>key_press 的按键名</summary>
    public string? Key { get; set; }

    /// <summary>key_combo 的按键列表，如 ["ctrl","c"]</summary>
    public List<string>? Keys { get; set; }

    /// <summary>text_type 要输入的文本</summary>
    public string? Text { get; set; }

    /// <summary>mouse_move 相对位移</summary>
    public int? Dx { get; set; }
    public int? Dy { get; set; }

    /// <summary>mouse_click：left | right | middle</summary>
    public string? Button { get; set; }

    /// <summary>scroll 垂直滚轮格数（正=向上）；delay 毫秒数</summary>
    public int? Amount { get; set; }

    /// <summary>scroll 水平滚轮格数（正=向右）</summary>
    public int? WheelDx { get; set; }

    /// <summary>browser_action 的动作名</summary>
    public string? Action { get; set; }

    /// <summary>browser_action 的参数</summary>
    public JsonNode? Payload { get; set; }

    /// <summary>execute_macro 的目标宏 ID</summary>
    public string? MacroId { get; set; }

    /// <summary>本步骤执行后的等待毫秒数</summary>
    public int DelayAfter { get; set; }
}
