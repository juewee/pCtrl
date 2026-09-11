using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;

namespace RemoteControl.Server.Services;

public static class NetworkHelper
{
    /// <summary>虚拟网卡/隧道关键字：这些地址手机通常连不上，排到后面</summary>
    private static readonly string[] VirtualHints =
    {
        "vethernet", "hyper-v", "vmware", "virtualbox", "vbox", "wsl", "docker",
        "loopback", "tap-", "tun", "tailscale", "zerotier", "npcap", "bluetooth", "vpn"
    };

    /// <summary>
    /// 获取本机活动网卡的 IPv4 地址，**真实局域网地址排在最前**：
    /// 有默认网关且不是虚拟网卡的最优先（Hyper-V/WSL/VMware 等虚拟地址排后），
    /// 手机端/托盘菜单就能直接选到能连通的地址。
    /// </summary>
    public static List<string> LocalIPv4()
    {
        var preferred = new List<string>();
        var others = new List<string>();
        try
        {
            foreach (var ni in NetworkInterface.GetAllNetworkInterfaces())
            {
                if (ni.OperationalStatus != OperationalStatus.Up) continue;
                if (ni.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;

                var props = ni.GetIPProperties();
                var hasGateway = props.GatewayAddresses.Any(g =>
                    g.Address.AddressFamily == AddressFamily.InterNetwork && !g.Address.Equals(IPAddress.Any));
                var isVirtual = IsVirtualAdapter(ni);

                foreach (var addr in props.UnicastAddresses)
                {
                    if (addr.Address.AddressFamily != AddressFamily.InterNetwork) continue;
                    if (IPAddress.IsLoopback(addr.Address)) continue;
                    var ip = addr.Address.ToString();
                    if (ip.StartsWith("169.254.", StringComparison.Ordinal)) continue; // APIPA 自分配地址
                    (hasGateway && !isVirtual ? preferred : others).Add(ip);
                }
            }
        }
        catch
        {
            // 忽略网络枚举失败
        }
        return preferred.Concat(others).Distinct().ToList();
    }

    private static bool IsVirtualAdapter(NetworkInterface ni)
    {
        var text = ((ni.Name ?? "") + " " + (ni.Description ?? "")).ToLowerInvariant();
        return VirtualHints.Any(h => text.Contains(h, StringComparison.Ordinal));
    }
}
