using System;
using System.Globalization;
using System.Runtime.InteropServices;

internal static class VirtualDisplay
{
    private const int CurrentSettings = -1;
    private const uint TestMode = 0x00000002;
    private const uint RotationFields = 0x00000080 | 0x00080000 | 0x00100000;

    [StructLayout(LayoutKind.Sequential)]
    private struct Point { public int X, Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct MonitorInfo
    {
        public int Size;
        public Rect Monitor, WorkArea;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string Device;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct DisplayDevice
    {
        public int Size;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string Name;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Description;
        public uint State;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Id;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Key;
    }

    // Layout of the display members of the Unicode DEVMODEW structure.
    [StructLayout(LayoutKind.Explicit, Size = 220)]
    private struct DisplayMode
    {
        [FieldOffset(68)] public ushort Size;
        [FieldOffset(72)] public uint Fields;
        [FieldOffset(84)] public uint Orientation;
        [FieldOffset(172)] public uint Width;
        [FieldOffset(176)] public uint Height;
    }

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromPoint(Point point, uint flags);

    [DllImport("user32.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
    private static extern bool GetMonitorInfoW(IntPtr monitor, ref MonitorInfo info);

    [DllImport("user32.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
    private static extern bool EnumDisplayDevicesW(string device, uint index, ref DisplayDevice data, uint flags);

    [DllImport("user32.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
    private static extern bool EnumDisplaySettingsExW(string device, int index, ref DisplayMode mode, uint flags);

    [DllImport("user32.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
    private static extern int ChangeDisplaySettingsExW(string device, ref DisplayMode mode, IntPtr window, uint flags, IntPtr reserved);

    public static int Rotate(string[] args)
    {
        if (args.Length != 6 || args[0] != "--orient-display" || (args[1] != "portrait" && args[1] != "landscape")) return 1;
        var bounds = new Rect();
        if (!ParseCoordinate(args[2], out bounds.Left) || !ParseCoordinate(args[3], out bounds.Top) ||
            !ParseCoordinate(args[4], out bounds.Right) || !ParseCoordinate(args[5], out bounds.Bottom) ||
            bounds.Left >= bounds.Right || bounds.Top >= bounds.Bottom) return 1;

        var center = new Point { X = bounds.Left / 2 + bounds.Right / 2, Y = bounds.Top / 2 + bounds.Bottom / 2 };
        IntPtr monitor = MonitorFromPoint(center, 0);
        var info = new MonitorInfo { Size = Marshal.SizeOf(typeof(MonitorInfo)) };
        if (monitor == IntPtr.Zero || !GetMonitorInfoW(monitor, ref info) || (info.Flags & 1) != 0 || !info.Monitor.Equals(bounds)) return 2;

        var device = new DisplayDevice { Size = Marshal.SizeOf(typeof(DisplayDevice)) };
        if (!EnumDisplayDevicesW(info.Device, 0, ref device, 1) ||
            device.Id.IndexOf("#MTT1337#", StringComparison.OrdinalIgnoreCase) < 0) return 2;

        var mode = new DisplayMode { Size = (ushort)Marshal.SizeOf(typeof(DisplayMode)) };
        if (!EnumDisplaySettingsExW(info.Device, CurrentSettings, ref mode, 0)) return 3;
        bool portrait = args[1] == "portrait";
        if ((mode.Height > mode.Width) == portrait) return 0;
        mode.Orientation = portrait ? 1u : 0u;
        uint width = mode.Width;
        mode.Width = mode.Height;
        mode.Height = width;
        mode.Fields = RotationFields;
        if (ChangeDisplaySettingsExW(info.Device, ref mode, IntPtr.Zero, TestMode, IntPtr.Zero) != 0) return 4;
        return ChangeDisplaySettingsExW(info.Device, ref mode, IntPtr.Zero, 0, IntPtr.Zero) == 0 ? 0 : 5;
    }

    private static bool ParseCoordinate(string value, out int coordinate)
    {
        return int.TryParse(value, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out coordinate);
    }
}
