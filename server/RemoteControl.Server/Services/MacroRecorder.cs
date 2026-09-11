using System.Diagnostics;
using System.Runtime.InteropServices;
using RemoteControl.Server.Models;

namespace RemoteControl.Server.Services;

/// <summary>
/// 宏录制器：通过 WH_KEYBOARD_LL / WH_MOUSE_LL 全局低级钩子记录键盘鼠标事件。
/// 必须在带有消息循环的 UI 线程上调用 Install()（托盘模式主线程）。
/// 自动忽略 SendInput 注入的事件，避免回放时反馈循环。
/// </summary>
public class MacroRecorder
{
    private const int WH_KEYBOARD_LL = 13;
    private const int WH_MOUSE_LL = 14;

    private const int WM_KEYDOWN = 0x0100;
    private const int WM_KEYUP = 0x0101;
    private const int WM_SYSKEYDOWN = 0x0104;
    private const int WM_SYSKEYUP = 0x0105;

    private const int WM_LBUTTONDOWN = 0x0201;
    private const int WM_RBUTTONDOWN = 0x0204;
    private const int WM_MBUTTONDOWN = 0x0207;
    private const int WM_MOUSEWHEEL = 0x020A;

    private const uint LLKHF_INJECTED = 0x10;
    private const uint LLMHF_INJECTED = 0x01;

    private IntPtr _kbdHook = IntPtr.Zero;
    private IntPtr _mouseHook = IntPtr.Zero;
    private LowLevelProc? _kbdProc;
    private LowLevelProc? _mouseProc;

    private readonly object _lock = new();
    private bool _recording;
    private List<MacroStep> _steps = new();
    private readonly HashSet<string> _heldMods = new(StringComparer.OrdinalIgnoreCase);
    private DateTime _lastEvent = DateTime.UtcNow;

    public bool IsInstalled { get; private set; }
    public bool IsRecording => _recording;

    private delegate IntPtr LowLevelProc(int nCode, IntPtr wParam, IntPtr lParam);

    public MacroRecorder(InputSimulatorService input)
    {
        // 输入模拟服务保留用于未来扩展（回放与录制分离）
        _ = input;
    }

    public void Install()
    {
        if (IsInstalled) return;

        _kbdProc = KbdCallback;
        _mouseProc = MouseCallback;

        using var process = Process.GetCurrentProcess();
        var moduleName = process.MainModule?.ModuleName ?? null;
        var hMod = moduleName != null ? GetModuleHandle(moduleName) : IntPtr.Zero;

        _kbdHook = SetWindowsHookEx(WH_KEYBOARD_LL, _kbdProc, hMod, 0);
        _mouseHook = SetWindowsHookEx(WH_MOUSE_LL, _mouseProc, hMod, 0);
        IsInstalled = _kbdHook != IntPtr.Zero && _mouseHook != IntPtr.Zero;

        if (!IsInstalled)
            Console.WriteLine("[Macro] 全局钩子安装失败，宏录制功能不可用。");
    }

    public void Start()
    {
        lock (_lock)
        {
            _steps = new List<MacroStep>();
            _heldMods.Clear();
            _lastEvent = DateTime.UtcNow;
            _recording = true;
        }
    }

    public List<MacroStep> Stop()
    {
        lock (_lock)
        {
            _recording = false;
            var result = _steps;
            _steps = new List<MacroStep>();
            _heldMods.Clear();
            return result;
        }
    }

    public void Cancel()
    {
        lock (_lock)
        {
            _recording = false;
            _steps = new List<MacroStep>();
            _heldMods.Clear();
        }
    }

    private IntPtr KbdCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0 && _recording)
        {
            try
            {
                var k = Marshal.PtrToStructure<KBDLLHOOKSTRUCT>(lParam);
                if ((k.flags & LLKHF_INJECTED) == 0 &&
                    KeyMapper.NameOf((VirtualKey)k.vkCode, out var name))
                {
                    var msg = wParam.ToInt32();
                    var down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
                    var up = msg == WM_KEYUP || msg == WM_SYSKEYUP;

                    if (down)
                    {
                        lock (_lock)
                        {
                            if (KeyMapper.IsModifierName(name))
                            {
                                _heldMods.Add(name);
                            }
                            else
                            {
                                var step = new MacroStep();
                                if (_heldMods.Count > 0)
                                {
                                    step.Type = "key_combo";
                                    step.Keys = _heldMods.Append(name).ToList();
                                    step.Key = name;
                                }
                                else
                                {
                                    step.Type = "key_press";
                                    step.Key = name;
                                }
                                AddStepLocked(step);
                            }
                        }
                    }
                    else if (up && KeyMapper.IsModifierName(name))
                    {
                        lock (_lock) _heldMods.Remove(name);
                    }
                }
            }
            catch { /* 钩子回调中不能抛异常 */ }
        }
        return CallNextHookEx(_kbdHook, nCode, wParam, lParam);
    }

    private IntPtr MouseCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0 && _recording)
        {
            try
            {
                var m = Marshal.PtrToStructure<MSLLHOOKSTRUCT>(lParam);
                if ((m.flags & LLMHF_INJECTED) == 0)
                {
                    switch (wParam.ToInt32())
                    {
                        case WM_LBUTTONDOWN:
                            lock (_lock) AddStepLocked(new MacroStep { Type = "mouse_click", Button = "left" });
                            break;
                        case WM_RBUTTONDOWN:
                            lock (_lock) AddStepLocked(new MacroStep { Type = "mouse_click", Button = "right" });
                            break;
                        case WM_MBUTTONDOWN:
                            lock (_lock) AddStepLocked(new MacroStep { Type = "mouse_click", Button = "middle" });
                            break;
                        case WM_MOUSEWHEEL:
                            var delta = (short)((m.mouseData >> 16) & 0xFFFF);
                            var notches = delta / 120;
                            if (notches != 0)
                                lock (_lock) AddStepLocked(new MacroStep { Type = "scroll", Amount = notches });
                            break;
                    }
                }
            }
            catch { }
        }
        return CallNextHookEx(_mouseHook, nCode, wParam, lParam);
    }

    /// <summary>记录步骤，并把与上一事件的时间差写入上一步骤的 DelayAfter</summary>
    private void AddStepLocked(MacroStep step)
    {
        var now = DateTime.UtcNow;
        var gap = (int)(now - _lastEvent).TotalMilliseconds;
        _lastEvent = now;
        if (_steps.Count > 0)
            _steps[^1].DelayAfter = Math.Clamp(gap, 0, 60_000);
        _steps.Add(step);
    }

    #region Win32

    [StructLayout(LayoutKind.Sequential)]
    private struct KBDLLHOOKSTRUCT
    {
        public uint vkCode;
        public uint scanCode;
        public uint flags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int x;
        public int y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSLLHOOKSTRUCT
    {
        public POINT pt;
        public uint mouseData;
        public uint flags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr GetModuleHandle(string lpModuleName);

    #endregion
}
