using System;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;

internal static class TabletPointer
{
    [StructLayout(LayoutKind.Sequential)]
    private struct Point { public int X, Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    private struct MonitorInfo { public int Size; public Rect Monitor, WorkArea; public uint Flags; }

    [StructLayout(LayoutKind.Sequential)]
    private struct MouseInput
    {
        public int X, Y;
        public uint Data, Flags, Time;
        public UIntPtr ExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Input { public uint Type; public MouseInput Mouse; }

    private const uint LeftDown = 0x0002;
    private const uint LeftUp = 0x0004;
    private const uint MoveAbsoluteOnDesktop = 0x0001 | 0x4000 | 0x8000;
    private const uint MouseWheelMessage = 0x020A;
    private const uint RootAncestor = 2;
    private const uint AbortIfHung = 0x0002;
    private const uint ErrorOnExit = 0x0020;
    private const int MaxWheelDelta = 480;
    private static readonly int InputSize = Marshal.SizeOf(typeof(Input));
    private static readonly object Gate = new object();
    private static bool held;
    private static long lastInput;

    [DllImport("user32.dll")]
    private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromPoint(Point point, uint flags);

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);

    [DllImport("user32.dll")]
    private static extern IntPtr WindowFromPoint(Point point);

    [DllImport("user32.dll")]
    private static extern IntPtr GetAncestor(IntPtr window, uint flags);

    [DllImport("user32.dll", ExactSpelling = true)]
    private static extern IntPtr SendMessageTimeoutW(IntPtr window, uint message, UIntPtr wParam,
        IntPtr lParam, uint flags, uint timeout, out UIntPtr result);

    [DllImport("user32.dll")]
    private static extern bool GetClipCursor(out Rect rectangle);

    [DllImport("user32.dll", ExactSpelling = true)]
    private static extern bool GetMonitorInfoW(IntPtr monitor, ref MonitorInfo info);

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int index);

    [DllImport("user32.dll")]
    private static extern uint SendInput(uint count, [In] Input[] inputs, int size);

    private static bool SendMouse(int x, int y, uint flags)
    {
        var input = new Input { Type = 0, Mouse = new MouseInput { X = x, Y = y, Flags = flags } };
        return SendInput(1, new[] { input }, InputSize) == 1;
    }

    private static bool Contains(Rect rect, int x, int y)
    {
        return x >= rect.Left && x < rect.Right && y >= rect.Top && y < rect.Bottom;
    }

    private static IntPtr SharedMonitor(Point point, Rect expected)
    {
        var info = new MonitorInfo { Size = Marshal.SizeOf(typeof(MonitorInfo)) };
        IntPtr monitor = MonitorFromPoint(point, 0);
        if (monitor == IntPtr.Zero || !GetMonitorInfoW(monitor, ref info) || (info.Flags & 1) != 0 ||
            !info.Monitor.Equals(expected)) return IntPtr.Zero;
        return monitor;
    }

    private static bool SendAt(int x, int y, Rect expected, uint flags)
    {
        Rect clipped;
        if (SharedMonitor(new Point { X = x, Y = y }, expected) == IntPtr.Zero ||
            !GetClipCursor(out clipped) || !Contains(clipped, x, y)) return false;

        int left = GetSystemMetrics(76), top = GetSystemMetrics(77);
        int width = GetSystemMetrics(78), height = GetSystemMetrics(79);
        if (width <= 0 || height <= 0 || x < left || y < top || x >= left + width || y >= top + height) return false;
        return SendMouse((int)((2L * (x - left) + 1) * 32768 / width),
            (int)((2L * (y - top) + 1) * 32768 / height), MoveAbsoluteOnDesktop | flags);
    }

    private static void SendWheel(int x, int y, Rect expected, int delta)
    {
        // WM_MOUSEWHEEL stores signed screen coordinates in two 16-bit fields.
        if (x < short.MinValue || x > short.MaxValue || y < short.MinValue || y > short.MaxValue) return;
        var point = new Point { X = x, Y = y };
        IntPtr monitor = SharedMonitor(point, expected);
        if (monitor == IntPtr.Zero) return;
        IntPtr window = WindowFromPoint(point);
        if (window == IntPtr.Zero || MonitorFromWindow(window, 0) != monitor) return;
        IntPtr root = GetAncestor(window, RootAncestor);
        if (root == IntPtr.Zero || MonitorFromWindow(root, 0) != monitor) return;

        // Address the hit window directly. Global input can route wheel motion to the focused window.
        UIntPtr result;
        SendMessageTimeoutW(window, MouseWheelMessage, new UIntPtr(unchecked((uint)(delta << 16))),
            new IntPtr((x & 0xffff) | (y << 16)), AbortIfHung | ErrorOnExit, 50, out result);
    }

    private static void Release()
    {
        if (held) held = !SendMouse(0, 0, LeftUp);
    }

    private static void Execute(string line)
    {
        if (line == "cancel") { Release(); return; }
        string[] parts = line.Split(' ');
        bool wheel = parts[0] == "wheel";
        if (parts.Length != (wheel ? 8 : 7)) return;
        var values = new int[parts.Length - 1];
        for (int i = 0; i < values.Length; i++)
        {
            if (!int.TryParse(parts[i + 1], NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out values[i])) return;
        }
        int x = values[0], y = values[1];
        var bounds = new Rect { Left = values[2], Top = values[3], Right = values[4], Bottom = values[5] };
        if (wheel)
        {
            int delta = values[6];
            if (!held && delta != 0 && delta >= -MaxWheelDelta && delta <= MaxWheelDelta)
                SendWheel(x, y, bounds, delta);
            return;
        }
        if (!Contains(bounds, x, y)) { Release(); return; }

        if (parts[0] == "down" && !held) held = SendAt(x, y, bounds, LeftDown);
        else if (parts[0] == "move" && held) { if (!SendAt(x, y, bounds, 0)) Release(); }
        else if (parts[0] == "up" && held)
        {
            if (SendAt(x, y, bounds, LeftUp)) held = false;
            else Release();
        }
        lastInput = Stopwatch.GetTimestamp();
    }

    private static void Main(string[] args)
    {
        SetThreadDpiAwarenessContext(new IntPtr(-4)); // Per-monitor DPI aware v2
        if (args.Length != 0)
        {
            Environment.ExitCode = args[0] == "--lease-display" || args[0] == "--probe-display"
                ? DisplayLease.Run(args[0] == "--probe-display")
                : VirtualDisplay.Change(args);
            return;
        }
        using (var watchdog = new Timer(_ =>
        {
            lock (Gate)
            {
                if (held && Stopwatch.GetTimestamp() - lastInput > Stopwatch.Frequency * 2) Release();
            }
        }, null, 250, 250))
        {
            try
            {
                string line;
                while ((line = Console.ReadLine()) != null)
                {
                    lock (Gate) Execute(line);
                    Console.WriteLine("ok");
                }
            }
            finally { lock (Gate) Release(); }
        }
    }
}
