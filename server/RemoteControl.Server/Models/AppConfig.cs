namespace RemoteControl.Server.Models;

/// <summary>电脑端服务配置（config.json）</summary>
public class AppConfig
{
    /// <summary>手机端 Web 服务端口</summary>
    public int Port { get; set; } = 5000;

    /// <summary>浏览器扩展本地桥接端口</summary>
    public int ExtensionPort { get; set; } = 8972;

    /// <summary>6 位配对码（首次启动随机生成）</summary>
    public string PairingCode { get; set; } = "";

    /// <summary>配对成功后签发的 Token（持久化，重连免配对）</summary>
    public string? Token { get; set; }

    /// <summary>设备名（显示在手机端状态栏）</summary>
    public string DeviceName { get; set; } = Environment.MachineName;

    public AiConfig Ai { get; set; } = new();
}

public class AiConfig
{
    /// <summary>none（本地规则解析） | openai（OpenAI 兼容接口，含 Ollama）</summary>
    public string Provider { get; set; } = "none";

    /// <summary>OpenAI 兼容地址，Ollama 为 http://127.0.0.1:11434/v1</summary>
    public string BaseUrl { get; set; } = "http://127.0.0.1:11434/v1";

    public string ApiKey { get; set; } = "";

    public string Model { get; set; } = "gpt-4o-mini";
}
