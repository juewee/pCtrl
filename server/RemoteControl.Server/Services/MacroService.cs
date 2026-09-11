using System.Text.Json;
using System.Text.Json.Nodes;
using RemoteControl.Server.Models;

namespace RemoteControl.Server.Services;

/// <summary>宏引擎：宏的加载、保存、增删改查与回放</summary>
public class MacroService
{
    private readonly ConfigService _config;
    private readonly InputSimulatorService _input;
    private readonly MacroRecorder _recorder;
    private readonly object _fileLock = new();
    private List<MacroDefinition> _macros;
    private readonly HashSet<string> _running = new();

    /// <summary>宏步骤中的 browser_action 通过此委托路由到命令分发器（扩展优先，按键回退）</summary>
    public Func<string, JsonNode?, CancellationToken, Task>? MediaActionAsync;

    public MacroService(ConfigService config, InputSimulatorService input, MacroRecorder recorder)
    {
        _config = config;
        _input = input;
        _recorder = recorder;
        _macros = Load();
    }

    public IReadOnlyList<MacroDefinition> All
    {
        get { lock (_fileLock) return _macros.ToList(); }
    }

    public MacroDefinition? Find(string id)
    {
        lock (_fileLock) return _macros.FirstOrDefault(m => m.Id == id);
    }

    public MacroDefinition Upsert(MacroDefinition macro)
    {
        lock (_fileLock)
        {
            if (string.IsNullOrWhiteSpace(macro.Id))
                macro.Id = "macro_" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var idx = _macros.FindIndex(m => m.Id == macro.Id);
            if (idx >= 0) _macros[idx] = macro;
            else _macros.Add(macro);
            SaveLocked();
            return macro;
        }
    }

    public bool Delete(string id)
    {
        lock (_fileLock)
        {
            var idx = _macros.FindIndex(m => m.Id == id);
            if (idx < 0) return false;
            _macros.RemoveAt(idx);
            SaveLocked();
            return true;
        }
    }

    public bool IsRecording => _recorder.IsRecording;

    public bool StartRecording()
    {
        if (!_recorder.IsInstalled) return false;
        _recorder.Start();
        return true;
    }

    public MacroDefinition? StopRecording()
    {
        if (!_recorder.IsRecording) return null;
        var steps = _recorder.Stop();
        return new MacroDefinition
        {
            Id = "macro_" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            Name = "新宏 " + DateTime.Now.ToString("MM-dd HH:mm"),
            Steps = steps
        };
    }

    public void CancelRecording()
    {
        if (_recorder.IsRecording) _recorder.Cancel();
    }

    public async Task<(bool ok, string? error)> ExecuteAsync(string macroId, CancellationToken ct = default)
    {
        MacroDefinition? macro;
        lock (_fileLock)
        {
            macro = _macros.FirstOrDefault(m => m.Id == macroId);
        }
        if (macro == null) return (false, "宏不存在");
        if (!_running.Add(macro.Id)) return (false, "该宏正在执行中");

        try
        {
            await RunStepsAsync(macro.Steps, ct, 0);
            return (true, null);
        }
        catch (OperationCanceledException)
        {
            return (false, "已取消");
        }
        catch (Exception ex)
        {
            return (false, ex.Message);
        }
        finally
        {
            _running.Remove(macro.Id);
        }
    }

    private async Task RunStepsAsync(List<MacroStep> steps, CancellationToken ct, int depth)
    {
        if (depth > 5) throw new InvalidOperationException("宏嵌套过深");

        foreach (var step in steps)
        {
            ct.ThrowIfCancellationRequested();

            switch (step.Type)
            {
                case "key_press":
                    _input.SendKey(step.Key);
                    break;

                case "key_combo":
                    var keys = step.Keys ?? new List<string>();
                    if (keys.Count == 1)
                        _input.SendKey(keys[0]);
                    else if (keys.Count > 1)
                        _input.SendKey(keys[^1], keys.Take(keys.Count - 1));
                    break;

                case "text_type":
                    _input.SendText(step.Text ?? "");
                    break;

                case "mouse_move":
                    _input.MouseMove(step.Dx ?? 0, step.Dy ?? 0);
                    break;

                case "mouse_click":
                    _input.MouseClick(step.Button ?? "left");
                    break;

                case "scroll":
                    _input.Scroll(step.Amount ?? 0, step.WheelDx ?? 0);
                    break;

                case "delay":
                    await Task.Delay(Math.Clamp(step.Amount ?? step.DelayAfter, 0, 600_000), ct);
                    break;

                case "browser_action":
                    if (MediaActionAsync != null && !string.IsNullOrEmpty(step.Action))
                        await MediaActionAsync(step.Action!, step.Payload, ct);
                    break;

                case "execute_macro":
                    if (!string.IsNullOrEmpty(step.MacroId))
                    {
                        var sub = Find(step.MacroId!);
                        if (sub != null) await RunStepsAsync(sub.Steps, ct, depth + 1);
                    }
                    break;
            }

            if (step.DelayAfter > 0 && step.Type != "delay")
                await Task.Delay(Math.Min(step.DelayAfter, 600_000), ct);
        }
    }

    #region 持久化

    private List<MacroDefinition> Load()
    {
        try
        {
            if (File.Exists(_config.MacrosPath))
            {
                var list = JsonSerializer.Deserialize<List<MacroDefinition>>(
                    File.ReadAllText(_config.MacrosPath), JsonOptions.Default);
                if (list != null) return list;
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[Macro] 加载宏失败：{ex.Message}");
        }

        var seeded = SeedMacros();
        Save(seeded);
        return seeded;
    }

    private void Save(List<MacroDefinition> macros)
    {
        try
        {
            File.WriteAllText(_config.MacrosPath, JsonSerializer.Serialize(macros, JsonOptions.Indented));
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[Macro] 保存宏失败：{ex.Message}");
        }
    }

    private void SaveLocked() => Save(_macros);

    private static List<MacroDefinition> SeedMacros() => new()
    {
        new MacroDefinition
        {
            Id = "macro_bilibili",
            Name = "打开B站并播放",
            Steps = new List<MacroStep>
            {
                new() { Type = "key_combo", Keys = new List<string> { "win", "r" }, DelayAfter = 400 },
                new() { Type = "text_type", Text = "https://www.bilibili.com", DelayAfter = 300 },
                new() { Type = "key_press", Key = "enter", DelayAfter = 7000 },
                new() { Type = "browser_action", Action = "play_pause", DelayAfter = 500 }
            }
        },
        new MacroDefinition
        {
            Id = "macro_fullscreen",
            Name = "切换全屏",
            Steps = new List<MacroStep>
            {
                new() { Type = "browser_action", Action = "fullscreen" }
            }
        },
        new MacroDefinition
        {
            Id = "macro_playpause",
            Name = "播放/暂停",
            Steps = new List<MacroStep>
            {
                new() { Type = "browser_action", Action = "play_pause" }
            }
        }
    };

    #endregion
}
