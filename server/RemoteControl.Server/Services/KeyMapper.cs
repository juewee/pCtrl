namespace RemoteControl.Server.Services;

/// <summary>Windows 虚拟键码（仅列出需要用到的）</summary>
public enum VirtualKey : ushort
{
    Backspace = 0x08,
    Tab = 0x09,
    Enter = 0x0D,
    Shift = 0x10,
    Control = 0x11,
    Alt = 0x12,
    Pause = 0x13,
    CapsLock = 0x14,
    Escape = 0x1B,
    Space = 0x20,
    PageUp = 0x21,
    PageDown = 0x22,
    End = 0x23,
    Home = 0x24,
    Left = 0x25,
    Up = 0x26,
    Right = 0x27,
    Down = 0x28,
    Insert = 0x2D,
    Delete = 0x2E,
    D0 = 0x30, D9 = 0x39,
    A = 0x41, Z = 0x5A,
    LWin = 0x5B,
    RWin = 0x5C,
    Numpad0 = 0x60, Numpad9 = 0x69,
    Multiply = 0x6A, Add = 0x6B, Subtract = 0x6D, Decimal = 0x6E, Divide = 0x6F,
    F1 = 0x70, F12 = 0x7B,
    NumLock = 0x90,
    ScrollLock = 0x91,
    LShift = 0xA0,
    RShift = 0xA1,
    LControl = 0xA2,
    RControl = 0xA3,
    LAlt = 0xA4,
    RAlt = 0xA5,
    VolumeMute = 0xAD,
    VolumeDown = 0xAE,
    VolumeUp = 0xAF,
    MediaNext = 0xB0,
    MediaPrev = 0xB1,
    MediaStop = 0xB2,
    MediaPlayPause = 0xB3,
    Semicolon = 0xBA,   // ; :
    Equal = 0xBB,        // = +
    Comma = 0xBC,        // , <
    Minus = 0xBD,        // - _
    Period = 0xBE,       // . >
    Slash = 0xBF,        // / ?
    Backtick = 0xC0,     // ` ~
    LeftBracket = 0xDB,  // [ {
    Backslash = 0xDC,    // \ |
    RightBracket = 0xDD, // ] }
    Quote = 0xDE,        // ' "
}

/// <summary>按键名 ↔ 虚拟键码映射</summary>
public static class KeyMapper
{
    private static readonly Dictionary<string, VirtualKey> NameToVk = new(StringComparer.OrdinalIgnoreCase);
    private static readonly Dictionary<ushort, string> VkToName = new();
    private static readonly HashSet<VirtualKey> Extended = new();
    private static readonly HashSet<string> ModifierNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "ctrl", "control", "alt", "shift", "win", "windows", "cmd", "meta"
    };

    static KeyMapper()
    {
        Map("backspace", VirtualKey.Backspace, "back", "bksp");
        Map("tab", VirtualKey.Tab);
        Map("enter", VirtualKey.Enter, "return", "ok");
        Map("shift", VirtualKey.Shift);
        Map("ctrl", VirtualKey.Control, "control");
        Map("alt", VirtualKey.Alt, "menu");
        Map("pause", VirtualKey.Pause);
        Map("capslock", VirtualKey.CapsLock, "caps");
        Map("esc", VirtualKey.Escape, "escape");
        Map("space", VirtualKey.Space, "spacebar");
        Map("pageup", VirtualKey.PageUp, "pgup");
        Map("pagedown", VirtualKey.PageDown, "pgdn");
        Map("end", VirtualKey.End);
        Map("home", VirtualKey.Home);
        Map("left", VirtualKey.Left, "arrowleft");
        Map("up", VirtualKey.Up, "arrowup");
        Map("right", VirtualKey.Right, "arrowright");
        Map("down", VirtualKey.Down, "arrowdown");
        Map("insert", VirtualKey.Insert, "ins");
        Map("delete", VirtualKey.Delete, "del");
        Map("win", VirtualKey.LWin, "windows", "cmd", "meta", "super");
        Map("vol_mute", VirtualKey.VolumeMute, "mute");
        Map("vol_down", VirtualKey.VolumeDown, "volume_down");
        Map("vol_up", VirtualKey.VolumeUp, "volume_up");
        Map("media_next", VirtualKey.MediaNext, "next_track");
        Map("media_prev", VirtualKey.MediaPrev, "prev_track");
        Map("media_stop", VirtualKey.MediaStop);
        Map("media_play", VirtualKey.MediaPlayPause, "play_pause");
        Map(";", VirtualKey.Semicolon);
        Map("=", VirtualKey.Equal);
        Map(",", VirtualKey.Comma);
        Map("-", VirtualKey.Minus);
        Map(".", VirtualKey.Period);
        Map("/", VirtualKey.Slash);
        Map("`", VirtualKey.Backtick);
        Map("[", VirtualKey.LeftBracket);
        Map("\\", VirtualKey.Backslash);
        Map("]", VirtualKey.RightBracket);
        Map("'", VirtualKey.Quote);
        Map("*", VirtualKey.Multiply);
        Map("+", VirtualKey.Add);
        Map("num_subtract", VirtualKey.Subtract);
        Map("num_decimal", VirtualKey.Decimal);
        Map("num_divide", VirtualKey.Divide);

        for (var c = '0'; c <= '9'; c++)
            Map(c.ToString(), (VirtualKey)(0x30 + (c - '0')));
        for (var c = 'a'; c <= 'z'; c++)
            Map(c.ToString(), (VirtualKey)(0x41 + (c - 'a')));
        for (var i = 0; i <= 9; i++)
            Map($"num{i}", (VirtualKey)(0x60 + i));
        for (var i = 1; i <= 12; i++)
            Map($"f{i}", (VirtualKey)(0x70 + (i - 1)));

        // 扩展键：方向键、导航键、音量/媒体键等，SendInput 时需带 KEYEVENTF_EXTENDEDKEY
        foreach (var vk in new[]
        {
            VirtualKey.Up, VirtualKey.Down, VirtualKey.Left, VirtualKey.Right,
            VirtualKey.PageUp, VirtualKey.PageDown, VirtualKey.Home, VirtualKey.End,
            VirtualKey.Insert, VirtualKey.Delete, VirtualKey.NumLock,
            VirtualKey.RControl, VirtualKey.RAlt, VirtualKey.Divide,
            VirtualKey.VolumeMute, VirtualKey.VolumeDown, VirtualKey.VolumeUp,
            VirtualKey.MediaNext, VirtualKey.MediaPrev, VirtualKey.MediaStop, VirtualKey.MediaPlayPause
        })
        {
            Extended.Add(vk);
        }
    }

    private static void Map(string name, VirtualKey vk, params string[] aliases)
    {
        NameToVk[name] = vk;
        foreach (var a in aliases) NameToVk[a] = vk;
        VkToName.TryAdd((ushort)vk, name);
    }

    public static bool TryParse(string? name, out VirtualKey vk)
    {
        vk = 0;
        if (string.IsNullOrWhiteSpace(name)) return false;
        return NameToVk.TryGetValue(name.Trim(), out vk);
    }

    public static bool IsModifierName(string name) => ModifierNames.Contains(name);

    public static bool IsExtended(VirtualKey vk) => Extended.Contains(vk);

    public static bool NameOf(VirtualKey vk, out string name)
    {
        if (VkToName.TryGetValue((ushort)vk, out var n) && n != null)
        {
            name = n;
            return true;
        }
        name = "";
        return false;
    }
}
