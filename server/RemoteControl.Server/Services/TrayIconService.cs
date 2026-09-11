using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace RemoteControl.Server.Services;

/// <summary>托盘图标：显示配对码/访问地址、宏录制开关、打开配置目录、退出</summary>
public class TrayIconService : IDisposable
{
    private readonly NotifyIcon _icon;
    private readonly ConfigService _config;
    private readonly MacroService _macros;
    private readonly Action _onExit;
    private ToolStripMenuItem? _recordItem;
    private readonly System.Windows.Forms.Timer _timer;

    public TrayIconService(ConfigService config, MacroService macros, Action onExit)
    {
        _config = config;
        _macros = macros;
        _onExit = onExit;

        var cfg = config.Get();

        _icon = new NotifyIcon
        {
            Icon = MakeIcon(),
            Visible = true,
            Text = "局域网智能遥控器"
        };

        var menu = new ContextMenuStrip();

        var codeItem = new ToolStripMenuItem($"配对码：{cfg.PairingCode}（点击复制）");
        codeItem.Click += (_, _) =>
        {
            TryClipboard(cfg.PairingCode);
            _icon.ShowBalloonTip(2000, "已复制", "配对码已复制到剪贴板", ToolTipIcon.Info);
        };
        menu.Items.Add(codeItem);

        var addrItem = new ToolStripMenuItem("手机访问地址（点击复制）");
        var ips = NetworkHelper.LocalIPv4();
        if (ips.Count == 0)
            addrItem.DropDownItems.Add(new ToolStripMenuItem("（未检测到局域网 IP）") { Enabled = false });
        foreach (var ip in ips)
        {
            var url = $"http://{ip}:{cfg.Port}";
            var it = new ToolStripMenuItem(url);
            it.Click += (_, _) =>
            {
                TryClipboard(url);
                _icon.ShowBalloonTip(2000, "已复制", url, ToolTipIcon.Info);
            };
            addrItem.DropDownItems.Add(it);
        }
        menu.Items.Add(addrItem);

        var openItem = new ToolStripMenuItem("在浏览器中打开（本机测试）");
        openItem.Click += (_, _) =>
        {
            try
            {
                Process.Start(new ProcessStartInfo($"http://localhost:{cfg.Port}") { UseShellExecute = true });
            }
            catch { }
        };
        menu.Items.Add(openItem);

        menu.Items.Add(new ToolStripSeparator());

        _recordItem = new ToolStripMenuItem("开始录制宏");
        _recordItem.Click += (_, _) => ToggleRecording();
        menu.Items.Add(_recordItem);

        menu.Items.Add(new ToolStripSeparator());

        var cfgItem = new ToolStripMenuItem("打开配置文件夹");
        cfgItem.Click += (_, _) =>
        {
            try
            {
                Process.Start(new ProcessStartInfo("explorer.exe", _config.ConfigDir) { UseShellExecute = true });
            }
            catch { }
        };
        menu.Items.Add(cfgItem);

        var exitItem = new ToolStripMenuItem("退出");
        exitItem.Click += (_, _) => _onExit();
        menu.Items.Add(exitItem);

        _icon.ContextMenuStrip = menu;

        var ipText = string.Join("   ", ips.Select(ip => $"http://{ip}:{cfg.Port}"));
        _icon.ShowBalloonTip(6000, "智能遥控器已启动",
            $"配对码：{cfg.PairingCode}\n手机浏览器访问：{ipText}", ToolTipIcon.Info);

        _timer = new System.Windows.Forms.Timer { Interval = 1000 };
        _timer.Tick += (_, _) =>
        {
            if (_recordItem != null)
                _recordItem.Text = _macros.IsRecording ? "■ 停止录制宏" : "开始录制宏";
        };
        _timer.Start();
    }

    private void ToggleRecording()
    {
        if (_macros.IsRecording)
        {
            var macro = _macros.StopRecording();
            if (macro != null)
            {
                macro.Name = "托盘录制 " + DateTime.Now.ToString("MM-dd HH:mm:ss");
                _macros.Upsert(macro);
                _icon.ShowBalloonTip(2000, "录制完成", $"已保存宏：{macro.Name}（{macro.Steps.Count} 步）", ToolTipIcon.Info);
            }
        }
        else
        {
            if (_macros.StartRecording())
                _icon.ShowBalloonTip(2000, "开始录制", "正在录制键盘鼠标操作，再次点击菜单停止", ToolTipIcon.Info);
            else
                _icon.ShowBalloonTip(2000, "录制不可用", "全局钩子安装失败", ToolTipIcon.Warning);
        }
    }

    private static void TryClipboard(string text)
    {
        try
        {
            var thread = new System.Threading.Thread(() => Clipboard.SetText(text));
            thread.SetApartmentState(System.Threading.ApartmentState.STA);
            thread.Start();
            thread.Join(1000);
        }
        catch { }
    }

    private static Icon MakeIcon()
    {
        using var bmp = new Bitmap(32, 32);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            using var bg = new SolidBrush(Color.FromArgb(108, 92, 231));
            g.FillEllipse(bg, 2, 2, 28, 28);
            using var wb = new SolidBrush(Color.White);
            // 遥控器图案：小圆点 + 长条
            g.FillEllipse(wb, 11, 8, 10, 10);
            g.FillRectangle(wb, 13, 21, 6, 4);
        }
        return Icon.FromHandle(bmp.GetHicon());
    }

    public void Dispose()
    {
        _timer.Stop();
        _icon.Visible = false;
        _icon.Dispose();
    }
}
