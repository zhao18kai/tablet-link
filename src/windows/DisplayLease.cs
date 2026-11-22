using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;

internal static class DisplayLease
{
    private const uint AllPaths = 1, ActivePaths = 2, PathActive = 1;
    private const uint SuppliedConfig = 0x20, Validate = 0x40, Apply = 0x80;
    private const uint InvalidMode = uint.MaxValue;
    private const uint SourceMode = 1, TargetName = 2, PreferredMode = 3;
    private const int InsufficientBuffer = 122;

    [StructLayout(LayoutKind.Sequential)]
    private struct Luid
    {
        public uint Low;
        public int High;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Source
    {
        public Luid Adapter;
        public uint Id, Mode, Status;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Target
    {
        public Luid Adapter;
        public uint Id, Mode, Technology, Rotation, Scaling;
        public uint RefreshNumerator, RefreshDenominator, Scan;
        public int Available;
        public uint Status;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Path
    {
        public Source Source;
        public Target Target;
        public uint Flags;
    }

    [StructLayout(LayoutKind.Explicit, Size = 64)]
    private struct Mode
    {
        [FieldOffset(0)] public uint Type;
        [FieldOffset(4)] public uint Id;
        [FieldOffset(8)] public Luid Adapter;
        [FieldOffset(16)] public uint Width;
        [FieldOffset(20)] public uint Height;
        [FieldOffset(24)] public uint PixelFormat;
        [FieldOffset(28)] public int X;
        [FieldOffset(32)] public int Y;
        // Preserve and compare the entire source/target mode union.
        [FieldOffset(36)] private uint data36;
        [FieldOffset(40)] private uint data40;
        [FieldOffset(44)] private uint data44;
        [FieldOffset(48)] private uint data48;
        [FieldOffset(52)] private uint data52;
        [FieldOffset(56)] private uint data56;
        [FieldOffset(60)] private uint data60;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct DeviceHeader
    {
        public uint Type, Size;
        public Luid Adapter;
        public uint Id;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct MonitorName
    {
        public DeviceHeader Header;
        public uint Flags, Technology;
        public ushort Manufacturer, Product;
        public uint Connector;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string Name;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DevicePath;
    }

    [StructLayout(LayoutKind.Explicit, Size = 80)]
    private struct TargetPreferredMode
    {
        [FieldOffset(0)] public DeviceHeader Header;
        [FieldOffset(20)] public uint Width;
        [FieldOffset(24)] public uint Height;
    }

    [DllImport("user32.dll")]
    private static extern int GetDisplayConfigBufferSizes(uint flags, out uint paths, out uint modes);

    [DllImport("user32.dll")]
    private static extern int QueryDisplayConfig(uint flags, ref uint pathCount, [Out] Path[] paths,
        ref uint modeCount, [Out] Mode[] modes, IntPtr topology);

    [DllImport("user32.dll")]
    private static extern int SetDisplayConfig(uint pathCount, [In] Path[] paths, uint modeCount, [In] Mode[] modes, uint flags);

    [DllImport("user32.dll")]
    private static extern int DisplayConfigGetDeviceInfo(ref MonitorName name);

    [DllImport("user32.dll")]
    private static extern int DisplayConfigGetDeviceInfo(ref TargetPreferredMode mode);

    private static bool ReadPaths(uint flags, out Path[] paths, out Mode[] modes)
    {
        for (int attempt = 0; attempt < 4; attempt++)
        {
            uint pathsCount, modesCount;
            if (GetDisplayConfigBufferSizes(flags, out pathsCount, out modesCount) != 0) break;
            paths = new Path[pathsCount];
            modes = new Mode[modesCount];
            int status = QueryDisplayConfig(flags, ref pathsCount, paths, ref modesCount, modes, IntPtr.Zero);
            if (status == InsufficientBuffer) continue;
            if (status != 0) break;
            Array.Resize(ref paths, (int)pathsCount);
            Array.Resize(ref modes, (int)modesCount);
            return true;
        }
        paths = null;
        modes = null;
        return false;
    }

    private static bool SameTarget(Target left, Target right)
    {
        return left.Id == right.Id && left.Adapter.Equals(right.Adapter);
    }

    private static bool SameSource(Source left, Source right)
    {
        return left.Id == right.Id && left.Adapter.Equals(right.Adapter);
    }

    private static DeviceHeader Header(uint type, Target target, Type structure)
    {
        return new DeviceHeader { Type = type, Size = (uint)Marshal.SizeOf(structure), Adapter = target.Adapter, Id = target.Id };
    }

    private static string MonitorPath(Target target)
    {
        var info = new MonitorName { Header = Header(TargetName, target, typeof(MonitorName)) };
        return DisplayConfigGetDeviceInfo(ref info) == 0 ? info.DevicePath ?? "" : "";
    }

    private static string FindStandby(Path[] paths, out Path standby)
    {
        var active = paths.Where(path => (path.Flags & PathActive) != 0).ToArray();
        foreach (Path path in paths)
        {
            if (path.Target.Available == 0 || active.Any(item => SameTarget(item.Target, path.Target) ||
                    SameSource(item.Source, path.Source))) continue;
            string identity = MonitorPath(path.Target);
            if (identity.IndexOf("#MTT1337#", StringComparison.OrdinalIgnoreCase) < 0) continue;
            standby = path;
            return identity;
        }
        standby = default(Path);
        return "";
    }

    private static bool Commit(Path[] paths, Mode[] modes, Path[] before, Mode[] beforeModes)
    {
        uint count = (uint)paths.Length, modeCount = (uint)modes.Length;
        if (SetDisplayConfig(count, paths, modeCount, modes, SuppliedConfig | Validate) != 0) return false;
        Path[] current;
        Mode[] currentModes;
        if (!ReadPaths(ActivePaths, out current, out currentModes) ||
                !before.SequenceEqual(current) || beforeModes.Length != currentModes.Length) return false;
        for (int i = 0; i < beforeModes.Length; i++)
        {
            Mode a = beforeModes[i], b = currentModes[i];
            if (a.Type == SourceMode && b.Type == SourceMode)
            {
                // The unused tail of the union for a source mode is not a display setting.
                if (!a.Adapter.Equals(b.Adapter) || a.Id != b.Id || a.Width != b.Width || a.Height != b.Height ||
                        a.PixelFormat != b.PixelFormat || a.X != b.X || a.Y != b.Y) return false;
            }
            else if (!a.Equals(b)) return false;
        }
        return SetDisplayConfig(count, paths, modeCount, modes, SuppliedConfig | Apply) == 0;
    }

    private static bool Attach(Path standby, Path[] active, Mode[] modes)
    {
        if (active.Length == 0 || active.Any(path => SameTarget(path.Target, standby.Target) ||
                SameSource(path.Source, standby.Source))) return false;
        var preferred = new TargetPreferredMode { Header = Header(PreferredMode, standby.Target, typeof(TargetPreferredMode)) };
        if (DisplayConfigGetDeviceInfo(ref preferred) != 0 || preferred.Width == 0 || preferred.Height == 0) return false;

        Mode rightmost = modes.Where(mode => mode.Type == SourceMode).OrderByDescending(mode => mode.X + (long)mode.Width).First();
        Path[] before = active;
        Mode[] beforeModes = modes;
        standby.Flags |= PathActive;
        standby.Source.Mode = (uint)modes.Length;
        standby.Target.Mode = InvalidMode;
        standby.Target.Rotation = 1;
        standby.Target.Scaling = 128;
        Array.Resize(ref modes, modes.Length + 1);
        modes[modes.Length - 1] = new Mode
        {
            Type = SourceMode, Id = standby.Source.Id, Adapter = standby.Source.Adapter, PixelFormat = 4,
            Width = preferred.Width, Height = preferred.Height, X = checked(rightmost.X + (int)rightmost.Width), Y = rightmost.Y
        };
        Array.Resize(ref active, active.Length + 1);
        active[active.Length - 1] = standby;
        return Commit(active, modes, before, beforeModes);
    }

    private static uint KeepMode(uint index, Mode[] modes, List<Mode> kept, Dictionary<uint, uint> remapped)
    {
        if (index == InvalidMode) return index;
        uint mapped;
        if (remapped.TryGetValue(index, out mapped)) return mapped;
        mapped = (uint)kept.Count;
        kept.Add(modes[index]);
        remapped.Add(index, mapped);
        return mapped;
    }

    private static bool IsConnected(Mode[] sources)
    {
        var reached = new bool[sources.Length];
        reached[0] = true;
        int count = 1;
        for (int pass = 0; pass < sources.Length && count < sources.Length; pass++)
        {
            int before = count;
            for (int i = 0; i < sources.Length; i++)
            {
                if (!reached[i]) continue;
                Mode a = sources[i];
                for (int j = 0; j < sources.Length; j++)
                {
                    if (reached[j]) continue;
                    Mode b = sources[j];
                    long overlapX = Math.Min(a.X + (long)a.Width, b.X + (long)b.Width) - Math.Max(a.X, b.X);
                    long overlapY = Math.Min(a.Y + (long)a.Height, b.Y + (long)b.Height) - Math.Max(a.Y, b.Y);
                    if ((overlapX > 0 && overlapY >= 0) || (overlapY > 0 && overlapX >= 0))
                    {
                        reached[j] = true;
                        count++;
                    }
                }
            }
            if (count == before) break;
        }
        return count == sources.Length;
    }

    private static bool Detach(Target target, string identity)
    {
        // Build the removal from the current topology so unrelated changes made during sharing are preserved.
        Path[] paths;
        Mode[] modes;
        if (!ReadPaths(ActivePaths, out paths, out modes)) return false;
        int index = Array.FindIndex(paths, path => SameTarget(path.Target, target));
        if (index < 0) return true;
        if (!string.Equals(identity, MonitorPath(paths[index].Target), StringComparison.OrdinalIgnoreCase)) return false;
        var source = modes[paths[index].Source.Mode];
        if (source.X == 0 && source.Y == 0) return false; // The user made this display primary.

        var remaining = paths.Where((_, position) => position != index).ToArray();
        // Windows would close a gap by moving unrelated displays. Keep the owned path if it is now a bridge.
        if (remaining.Length == 0 || !IsConnected(remaining.Select(path => modes[path.Source.Mode]).ToArray())) return false;
        var kept = new List<Mode>();
        var remapped = new Dictionary<uint, uint>();
        for (int i = 0; i < remaining.Length; i++)
        {
            remaining[i].Source.Mode = KeepMode(remaining[i].Source.Mode, modes, kept, remapped);
            remaining[i].Target.Mode = KeepMode(remaining[i].Target.Mode, modes, kept, remapped);
        }
        return Commit(remaining, kept.ToArray(), paths, modes);
    }

    public static int Run(bool probe)
    {
        Path[] paths;
        Mode[] modes;
        if (!ReadPaths(AllPaths, out paths, out modes)) return 11;
        Path standby;
        string identity = FindStandby(paths, out standby);
        if (identity.Length == 0) return 10;
        if (probe) return 0;
        if (!ReadPaths(ActivePaths, out paths, out modes) ||
            !string.Equals(identity, MonitorPath(standby.Target), StringComparison.OrdinalIgnoreCase) ||
            !Attach(standby, paths, modes)) return 11;

        int result = 11;
        bool alreadyDetached = false;
        try
        {
            for (int attempt = 0; attempt < 25; attempt++)
            {
                if (ReadPaths(ActivePaths, out paths, out modes))
                {
                    int index = Array.FindIndex(paths, path => SameTarget(path.Target, standby.Target) &&
                        SameSource(path.Source, standby.Source));
                    if (index >= 0)
                    {
                        Mode desktop = modes[paths[index].Source.Mode];
                        Console.WriteLine(string.Format(CultureInfo.InvariantCulture, "READY {0} {1} {2} {3}",
                            desktop.X, desktop.Y, desktop.Width, desktop.Height));
                        // A real removal observed by Electron ends our ownership, even if the user reconnects it.
                        // EOF also releases the display when the parent process exits.
                        alreadyDetached = Console.In.ReadLine() == "DETACHED";
                        result = 0;
                        break;
                    }
                }
                Thread.Sleep(100);
            }
        }
        finally
        {
            if (!alreadyDetached && !Detach(standby.Target, identity)) result = 12;
        }
        return result;
    }
}
