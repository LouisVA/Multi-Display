param(
    [Parameter(Mandatory)]
    [ValidateSet('Inspect', 'Connect', 'Disconnect')]
    [string]$Action,
    [string]$ReceiverKey
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Linq;
using System.Runtime.InteropServices;

public static class CastDisplays
{
    private const uint OnlyActivePaths = 2;
    private const uint Apply = 0x80;
    private const uint Extend = 4;
    private const uint UseSuppliedConfiguration = 0x20;
    private const uint Miracast = 15;

    [StructLayout(LayoutKind.Sequential)]
    private struct AdapterId { public uint Low; public int High; }

    [StructLayout(LayoutKind.Sequential)]
    private struct SourcePath
    {
        public AdapterId Adapter;
        public uint Id, ModeIndex, StatusFlags;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct TargetPath
    {
        public AdapterId Adapter;
        public uint Id, ModeIndex, Technology, Rotation, Scaling;
        public uint RefreshNumerator, RefreshDenominator, ScanlineOrdering, Available, StatusFlags;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct DisplayPath { public SourcePath Source; public TargetPath Target; public uint Flags; }

    [StructLayout(LayoutKind.Explicit, Size = 64)]
    private struct DisplayMode
    {
        [FieldOffset(0)] public uint Type;
        [FieldOffset(16)] public uint Width;
        [FieldOffset(20)] public uint Height;
        [FieldOffset(28)] public int X;
        [FieldOffset(32)] public int Y;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct TargetName
    {
        public uint Type, Size;
        public AdapterId Adapter;
        public uint Id, Flags, Technology;
        public ushort EdidManufacturer, EdidProduct;
        public uint ConnectorInstance;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string Name;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DevicePath;
    }

    [DllImport("user32.dll")]
    private static extern int GetDisplayConfigBufferSizes(uint flags, out uint pathCount, out uint modeCount);

    [DllImport("user32.dll")]
    private static extern int QueryDisplayConfig(uint flags, ref uint pathCount, [Out] DisplayPath[] paths,
        ref uint modeCount, [Out] DisplayMode[] modes, IntPtr topology);

    [DllImport("user32.dll")]
    private static extern int SetDisplayConfig(uint pathCount, [In] DisplayPath[] paths,
        uint modeCount, [In] DisplayMode[] modes, uint flags);

    [DllImport("user32.dll")]
    private static extern int DisplayConfigGetDeviceInfo(ref TargetName name);

    public sealed class Display
    {
        public string Key, Source;
        public bool Wireless, Separate;
        public int X, Y;
        public uint Width, Height;
    }

    private static string Key(AdapterId adapter, uint id)
    {
        return adapter.High + ":" + adapter.Low + ":" + id;
    }

    private static void ReadConfiguration(out DisplayPath[] paths, out DisplayMode[] modes)
    {
        const int InsufficientBuffer = 122;
        for (int attempt = 0; attempt < 4; attempt++)
        {
            uint pathCount, modeCount;
            int result = GetDisplayConfigBufferSizes(OnlyActivePaths, out pathCount, out modeCount);
            if (result != 0) throw new Win32Exception(result);
            paths = new DisplayPath[pathCount];
            modes = new DisplayMode[modeCount];
            result = QueryDisplayConfig(OnlyActivePaths, ref pathCount, paths, ref modeCount, modes, IntPtr.Zero);
            if (result == InsufficientBuffer) continue;
            if (result != 0) throw new Win32Exception(result);
            Array.Resize(ref paths, (int)pathCount);
            Array.Resize(ref modes, (int)modeCount);
            return;
        }
        throw new Win32Exception(InsufficientBuffer);
    }

    private static bool IsMiracast(TargetPath target)
    {
        if (target.Technology == Miracast) return true;
        // A receiver can report its TV connector (for example HDMI) on the display path.
        var name = new TargetName {
            Type = 2, Size = (uint)Marshal.SizeOf(typeof(TargetName)), Adapter = target.Adapter, Id = target.Id
        };
        return DisplayConfigGetDeviceInfo(ref name) == 0 && name.Technology == Miracast;
    }

    public static Display[] Read()
    {
        DisplayPath[] paths;
        DisplayMode[] modes;
        ReadConfiguration(out paths, out modes);
        return paths.Select(path => {
            var source = path.Source;
            var mode = source.ModeIndex < modes.Length ? modes[source.ModeIndex] : new DisplayMode();
            var sourceKey = Key(source.Adapter, source.Id);
            return new Display {
                Key = Key(path.Target.Adapter, path.Target.Id),
                Source = sourceKey,
                Wireless = path.Target.Available != 0 && IsMiracast(path.Target),
                Separate = mode.Type == 1 && paths.Any(other => Key(other.Source.Adapter, other.Source.Id) != sourceKey)
                    && paths.Count(other => Key(other.Source.Adapter, other.Source.Id) == sourceKey) == 1,
                X = mode.X, Y = mode.Y, Width = mode.Width, Height = mode.Height
            };
        }).ToArray();
    }

    public static void ExtendDesktop()
    {
        int result = SetDisplayConfig(0, null, 0, null, Apply | Extend);
        if (result != 0) throw new Win32Exception(result);
    }

    public static void Disconnect(string receiverKey)
    {
        DisplayPath[] paths;
        DisplayMode[] modes;
        ReadConfiguration(out paths, out modes);
        var remaining = paths.Where(path =>
            Key(path.Target.Adapter, path.Target.Id) != receiverKey || !IsMiracast(path.Target)).ToArray();
        if (remaining.Length == paths.Length) return;
        if (remaining.Length == 0) throw new InvalidOperationException("No other display is available.");
        int result = SetDisplayConfig((uint)remaining.Length, remaining, (uint)modes.Length, modes,
            Apply | UseSuppliedConfiguration);
        if (result != 0) throw new Win32Exception(result);
    }
}
'@

if ($Action -eq 'Inspect') {
    ConvertTo-Json -InputObject ([CastDisplays]::Read()) -Compress
    return
}

if ($Action -eq 'Disconnect') {
    [CastDisplays]::Disconnect($ReceiverKey)
    return
}

$known = @([CastDisplays]::Read() | ForEach-Object Key)
Start-Process 'ms-settings-connectabledevices:devicediscovery'
$deadline = [DateTime]::UtcNow.AddSeconds(60)
$extendRequested = $false
do {
    Start-Sleep -Milliseconds 350
    $newReceivers = @([CastDisplays]::Read() | Where-Object { $_.Wireless -and $_.Key -notin $known })
    if ($newReceivers.Count -ne 1) { continue }
    $receiver = $newReceivers[0]
    if ($receiver.Separate) {
        $receiver | ConvertTo-Json -Compress
        return
    }
    if (!$extendRequested) {
        [CastDisplays]::ExtendDesktop()
        $extendRequested = $true
    }
} while ([DateTime]::UtcNow -lt $deadline)
'null'
