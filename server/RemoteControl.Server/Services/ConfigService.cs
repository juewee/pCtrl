using System.Text.Json;
using RemoteControl.Server.Models;

namespace RemoteControl.Server.Services;

/// <summary>配置文件管理（config.json / macros.json，与 exe 同目录）</summary>
public class ConfigService
{
    public string ConfigDir { get; }
    public string ConfigPath => Path.Combine(ConfigDir, "config.json");
    public string MacrosPath => Path.Combine(ConfigDir, "macros.json");

    private AppConfig? _cache;
    private readonly object _lock = new();

    public ConfigService()
    {
        ConfigDir = AppContext.BaseDirectory;
        try
        {
            Directory.CreateDirectory(ConfigDir);
        }
        catch
        {
            // 忽略目录创建失败
        }
    }

    public AppConfig Get()
    {
        lock (_lock)
        {
            if (_cache != null) return _cache;

            AppConfig? cfg = null;
            try
            {
                if (File.Exists(ConfigPath))
                    cfg = JsonSerializer.Deserialize<AppConfig>(File.ReadAllText(ConfigPath), JsonOptions.Default);
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[Config] 读取配置失败：{ex.Message}");
            }

            cfg ??= new AppConfig();

            if (string.IsNullOrWhiteSpace(cfg.PairingCode))
                cfg.PairingCode = Random.Shared.Next(100000, 1000000).ToString();

            _cache = cfg;
            Save(cfg);
            return cfg;
        }
    }

    public void Save(AppConfig cfg)
    {
        lock (_lock)
        {
            _cache = cfg;
            try
            {
                File.WriteAllText(ConfigPath, JsonSerializer.Serialize(cfg, JsonOptions.Indented));
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[Config] 保存配置失败：{ex.Message}");
            }
        }
    }
}
