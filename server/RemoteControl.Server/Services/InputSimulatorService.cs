using System.Runtime.InteropServices;

namespace RemoteControl.Server.Services;

/// <summary>
/// 输入模拟引擎：基于 Windows SendInput（user32.dll），零第三方依赖。
/// 控制以管理员身份运行的窗口时，本程序也需要管理员权限。
/// </summary>
public class InputSimulatorService
{
    /// <summary>当前仍按下的键（用于断线时统一释放，防止卡键）</summary>
    private readonly HashSet<VirtualKey> _held = new();
    private readonly object _heldLock = new();

    #region Win32

    private const uint INPUT_MOUSE = 0;
    private const uint INPUT_KEYBOARD = 1;

    private const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint KEYEVENTF_UNICODE = 0x0004;

    private const uint MOUSEEVENTF_MOVE = 0x0001;
    private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    private const uint MOUSEEVENTF_LEFTUP = 0x0004;
    private const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    private const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    private const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    private const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    private const uint MOUSEEVENTF_WHEEL = 0x0800;
    private const uint MOUSEEVENTF_HWHEEL = 0x1000;

    private const int WHEEL_DELTA = 120;

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT
    {
        public uint type;
        public InputUnion U;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    #endregion

    /// <summary>按下并松开一个按键，可带修饰键（ctrl/alt/shift/win）</summary>
    public void SendKey(string? key, IEnumerable<string?>? modifiers = null)
    {
        if (string.IsNullOrWhiteSpace(key) || !KeyMapper.TryParse(key, out var vk))
            return;

        var held = new List<VirtualKey>();
        try
        {
            foreach (var m in modifiers ?? Array.Empty<string?>())
            {
                if (KeyMapper.TryParse(m, out var mvk))
                {
                    KeyEvent(mvk, false);
                    held.Add(mvk);
                }
            }
            KeyEvent(vk, false);
            KeyEvent(vk, true);
        }
        finally
        {
            for (var i = held.Count - 1; i >= 0; i--)
                KeyEvent(held[i], true);
        }
    }

    /// <summary>单击虚拟键（播放/暂停等回退操作使用）</summary>
    public void Tap(VirtualKey vk)
    {
        KeyEvent(vk, false);
        KeyEvent(vk, true);
    }

    /// <summary>仅按下一个键（长按场景，如 B站长按右方向键倍速），需配对 KeyUp</summary>
    public bool KeyDown(string? key)
    {
        if (string.IsNullOrWhiteSpace(key) || !KeyMapper.TryParse(key, out var vk)) return false;
        KeyEvent(vk, false);
        lock (_heldLock) _held.Add(vk);
        return true;
    }

    /// <summary>松开 KeyDown 按下的键</summary>
    public bool KeyUp(string? key)
    {
        if (string.IsNullOrWhiteSpace(key) || !KeyMapper.TryParse(key, out var vk)) return false;
        lock (_heldLock) _held.Remove(vk);
        KeyEvent(vk, true);
        return true;
    }

    /// <summary>
    /// 释放所有仍处于按下状态的键。手机端断开/切到后台时调用，
    /// 避免长按倍速后连接中断导致电脑上方向键或修饰键一直按着（卡键）。
    /// </summary>
    public void ReleaseAll()
    {
        List<VirtualKey> keys;
        lock (_heldLock)
        {
            keys = _held.ToList();
            _held.Clear();
        }
        foreach (var vk in keys)
        {
            try { KeyEvent(vk, true); } catch { /* 忽略单个键释放失败 */ }
        }
    }

    /// <summary>逐字符输入 Unicode 文本</summary>
    public void SendText(string text)
    {
        if (string.IsNullOrEmpty(text)) return;
        var inputs = new List<INPUT>(text.Length * 2);
        foreach (var ch in text)
        {
            inputs.Add(MakeUnicode(ch, false));
            inputs.Add(MakeUnicode(ch, true));
        }
        Send(inputs.ToArray());
    }

    /// <summary>相对移动鼠标（像素）</summary>
    public void MouseMove(int dx, int dy)
    {
        if (dx == 0 && dy == 0) return;
        Send(MakeMouse((uint)0, dx, dy, 0));
    }

    /// <summary>在当前位置点击鼠标键：left / right / middle</summary>
    public void MouseClick(string button = "left")
    {
        switch ((button ?? "left").ToLowerInvariant())
        {
            case "right":
                Send(MakeMouse(MOUSEEVENTF_RIGHTDOWN));
                Send(MakeMouse(MOUSEEVENTF_RIGHTUP));
                break;
            case "middle":
                Send(MakeMouse(MOUSEEVENTF_MIDDLEDOWN));
                Send(MakeMouse(MOUSEEVENTF_MIDDLEUP));
                break;
            default:
                Send(MakeMouse(MOUSEEVENTF_LEFTDOWN));
                Send(MakeMouse(MOUSEEVENTF_LEFTUP));
                break;
        }
    }

    /// <summary>滚轮滚动。dy 正=向上，dx 正=向右，单位为滚轮格数</summary>
    public void Scroll(int dy, int dx = 0)
    {
        if (dy != 0)
            Send(MakeMouse(MOUSEEVENTF_WHEEL, 0, 0, unchecked((uint)(dy * WHEEL_DELTA))));
        if (dx != 0)
            Send(MakeMouse(MOUSEEVENTF_HWHEEL, 0, 0, unchecked((uint)(dx * WHEEL_DELTA))));
    }

    #region 内部

    private static void KeyEvent(VirtualKey vk, bool up)
    {
        var flags = (up ? KEYEVENTF_KEYUP : 0u) | (KeyMapper.IsExtended(vk) ? KEYEVENTF_EXTENDEDKEY : 0u);
        var input = new INPUT
        {
            type = INPUT_KEYBOARD,
            U = new InputUnion
            {
                ki = new KEYBDINPUT
                {
                    wVk = (ushort)vk,
                    wScan = 0,
                    dwFlags = flags,
                    time = 0,
                    dwExtraInfo = IntPtr.Zero
                }
            }
        };
        Send(input);
    }

    private static INPUT MakeUnicode(char ch, bool up) => new()
    {
        type = INPUT_KEYBOARD,
        U = new InputUnion
        {
            ki = new KEYBDINPUT
            {
                wVk = 0,
                wScan = (ushort)ch,
                dwFlags = KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0u),
                time = 0,
                dwExtraInfo = IntPtr.Zero
            }
        }
    };

    private static INPUT MakeMouse(uint flags, int dx = 0, int dy = 0, uint mouseData = 0) => new()
    {
        type = INPUT_MOUSE,
        U = new InputUnion
        {
            mi = new MOUSEINPUT
            {
                dx = dx,
                dy = dy,
                mouseData = mouseData,
                dwFlags = flags | (dx != 0 || dy != 0 ? MOUSEEVENTF_MOVE : 0u),
                time = 0,
                dwExtraInfo = IntPtr.Zero
            }
        }
    };

    private static void Send(params INPUT[] inputs)
    {
        if (inputs.Length == 0) return;
        SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<INPUT>());
    }

    #endregion
}
