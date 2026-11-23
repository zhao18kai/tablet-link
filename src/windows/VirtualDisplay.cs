using System;
using System.Globalization;
using System.Runtime.InteropServices;

internal static class VirtualDisplay
{
    private const int CurrentSettings = -1;
    private const uint TestMode = 0x00000002;
    private const uint UpdateRegistry = 0x00000001;
    private const uint PositionField = 0x00000020;
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
        [FieldOffset(76)] public int X;
        [FieldOffset(80)] public int Y;
        [FieldOffset(84)] public uint Orientation;
        [FieldOffset(172)] public uint Width;
        [FieldOffset(176)] public uint Height;
    }

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromPoint(Point point, uint flags);

    private delegate bool MonitorCallback(IntPtr monitor, IntPtr dc, ref Rect bounds, IntPtr data);

    [DllImport("user32.dll")]
    private static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonitorCallback callback, IntPtr data);

    [DllImport("user32.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
    private static extern bool GetMonitorInfoW(IntPtr monitor, ref MonitorInfo info);

    [DllImport("user32.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
    private static extern bool EnumDisplayDevicesW(string device, uint index, ref DisplayDevice data, uint flags);

    [DllImport("user32.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
    private static extern bool EnumDisplaySettingsExW(string device, int index, ref DisplayMode mode, uint flags);

    [DllImport("user32.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
    private static extern int ChangeDisplaySettingsExW(string device, ref DisplayMode mode, IntPtr window, uint flags, IntPtr reserved);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct DxgiOutput
    {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string Device;
        public Rect Desktop;
        public int Attached;
        public int Rotation;
        public IntPtr Monitor;
    }

    [DllImport("dxgi.dll", ExactSpelling = true)]
    private static extern int CreateDXGIFactory1(ref Guid iid, out IntPtr factory);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int Enumerate(IntPtr self, uint index, out IntPtr item);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int DescribeOutput(IntPtr self, out DxgiOutput description);

    private static IntPtr DxgiMethod(IntPtr item, int index)
    {
        return Marshal.ReadIntPtr(Marshal.ReadIntPtr(item), index * IntPtr.Size);
    }

    public static int FindDxgiOutput(string[] args)
    {
        var bounds = new Rect();
        if (args.Length != 5 || !ParseCoordinate(args[1], out bounds.Left) ||
            !ParseCoordinate(args[2], out bounds.Top) || !ParseCoordinate(args[3], out bounds.Right) ||
            !ParseCoordinate(args[4], out bounds.Bottom) || bounds.Left >= bounds.Right || bounds.Top >= bounds.Bottom) return 1;

        var center = new Point { X = bounds.Left / 2 + bounds.Right / 2, Y = bounds.Top / 2 + bounds.Bottom / 2 };
        IntPtr monitor = MonitorFromPoint(center, 0);
        var info = new MonitorInfo { Size = Marshal.SizeOf(typeof(MonitorInfo)) };
        if (monitor == IntPtr.Zero || !GetMonitorInfoW(monitor, ref info) || (info.Flags & 1) != 0 ||
            !MatchesBounds(info.Monitor, bounds)) return 2;

        var iid = new Guid("770aae78-f26f-4dba-a829-253c83d1b387");
        IntPtr factory;
        if (CreateDXGIFactory1(ref iid, out factory) != 0) return 3;
        try
        {
            // IDXGIFactory1::EnumAdapters1, then IDXGIAdapter::EnumOutputs and IDXGIOutput::GetDesc.
            var enumerateAdapters = (Enumerate)Marshal.GetDelegateForFunctionPointer(DxgiMethod(factory, 12), typeof(Enumerate));
            for (uint adapterIndex = 0; ; adapterIndex++)
            {
                IntPtr adapter;
                if (enumerateAdapters(factory, adapterIndex, out adapter) != 0) break;
                try
                {
                    var enumerateOutputs = (Enumerate)Marshal.GetDelegateForFunctionPointer(DxgiMethod(adapter, 7), typeof(Enumerate));
                    for (uint outputIndex = 0; ; outputIndex++)
                    {
                        IntPtr output;
                        if (enumerateOutputs(adapter, outputIndex, out output) != 0) break;
                        try
                        {
                            DxgiOutput description;
                            var describe = (DescribeOutput)Marshal.GetDelegateForFunctionPointer(DxgiMethod(output, 7), typeof(DescribeOutput));
                            if (describe(output, out description) != 0 || description.Attached == 0 ||
                                description.Rotation != 1 || description.Monitor != monitor ||
                                !String.Equals(description.Device, info.Device, StringComparison.OrdinalIgnoreCase) ||
                                !MatchesBounds(description.Desktop, info.Monitor)) continue;
                            Console.WriteLine("{0} {1} {2} {3}", adapterIndex, outputIndex,
                                description.Desktop.Right - description.Desktop.Left,
                                description.Desktop.Bottom - description.Desktop.Top);
                            return 0;
                        }
                        finally { Marshal.Release(output); }
                    }
                }
                finally { Marshal.Release(adapter); }
            }
        }
        finally { Marshal.Release(factory); }
        return 4;
    }

    public static int Change(string[] args)
    {
        bool placing = args[0] == "--place-display";
        if (placing ? args.Length != 7 : args.Length != 6 || args[0] != "--orient-display" ||
            (args[1] != "portrait" && args[1] != "landscape")) return 1;

        int offset = placing ? 1 : 2;
        var bounds = new Rect();
        if (!ParseCoordinate(args[offset], out bounds.Left) || !ParseCoordinate(args[offset + 1], out bounds.Top) ||
            !ParseCoordinate(args[offset + 2], out bounds.Right) || !ParseCoordinate(args[offset + 3], out bounds.Bottom) ||
            bounds.Left >= bounds.Right || bounds.Top >= bounds.Bottom) return 1;

        var center = new Point { X = bounds.Left / 2 + bounds.Right / 2, Y = bounds.Top / 2 + bounds.Bottom / 2 };
        IntPtr monitor = MonitorFromPoint(center, 0);
        var info = new MonitorInfo { Size = Marshal.SizeOf(typeof(MonitorInfo)) };
        if (monitor == IntPtr.Zero || !GetMonitorInfoW(monitor, ref info) || (info.Flags & 1) != 0 ||
            !MatchesBounds(info.Monitor, bounds)) return 2;
        bounds = info.Monitor;

        var device = new DisplayDevice { Size = Marshal.SizeOf(typeof(DisplayDevice)) };
        if (!EnumDisplayDevicesW(info.Device, 0, ref device, 1) ||
            device.Id.IndexOf("#MTT1337#", StringComparison.OrdinalIgnoreCase) < 0) return 2;

        var mode = new DisplayMode { Size = (ushort)Marshal.SizeOf(typeof(DisplayMode)) };
        if (!EnumDisplaySettingsExW(info.Device, CurrentSettings, ref mode, 0)) return 3;
        if (placing)
        {
            if (!ParseCoordinate(args[5], out mode.X) || !ParseCoordinate(args[6], out mode.Y)) return 1;
            var target = new Rect
            {
                Left = mode.X, Top = mode.Y,
                Right = mode.X + (bounds.Right - bounds.Left), Bottom = mode.Y + (bounds.Bottom - bounds.Top)
            };
            if (!CanPlace(monitor, target)) return 2;
            mode.Fields = PositionField;
            return Apply(info.Device, ref mode, UpdateRegistry);
        }

        bool portrait = args[1] == "portrait";
        if ((mode.Height > mode.Width) == portrait) return 0;
        mode.Orientation = portrait ? 1u : 0u;
        uint width = mode.Width;
        mode.Width = mode.Height;
        mode.Height = width;
        mode.Fields = RotationFields;
        return Apply(info.Device, ref mode, 0);
    }

    private static int Apply(string device, ref DisplayMode mode, uint flags)
    {
        if (ChangeDisplaySettingsExW(device, ref mode, IntPtr.Zero, TestMode, IntPtr.Zero) != 0) return 4;
        return ChangeDisplaySettingsExW(device, ref mode, IntPtr.Zero, flags, IntPtr.Zero) == 0 ? 0 : 5;
    }

    private static bool CanPlace(IntPtr monitor, Rect target)
    {
        bool adjacent = false;
        bool overlap = false;
        return EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate(IntPtr current, IntPtr dc, ref Rect other, IntPtr data)
        {
            if (current == monitor) return true;
            bool sharesX = target.Left < other.Right && target.Right > other.Left;
            bool sharesY = target.Top < other.Bottom && target.Bottom > other.Top;
            overlap |= sharesX && sharesY;
            adjacent |= (sharesX && (target.Top == other.Bottom || target.Bottom == other.Top)) ||
                (sharesY && (target.Left == other.Right || target.Right == other.Left));
            return !overlap;
        }, IntPtr.Zero) && adjacent && !overlap;
    }

    private static bool ParseCoordinate(string value, out int coordinate)
    {
        return int.TryParse(value, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out coordinate);
    }

    private static bool MatchesBounds(Rect actual, Rect expected)
    {
        // Electron's integer DIPs can enclose up to several additional physical pixels.
        return Math.Abs((long)actual.Left - expected.Left) <= 8 && Math.Abs((long)actual.Top - expected.Top) <= 8 &&
            Math.Abs((long)actual.Right - expected.Right) <= 8 && Math.Abs((long)actual.Bottom - expected.Bottom) <= 8;
    }
}
