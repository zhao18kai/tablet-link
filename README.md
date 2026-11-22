# 平板智联

Windows 11 局域网副屏工具。电脑采集选中的 Windows 显示器，MatePad 通过浏览器接收。每次连接需要在电脑上批准，一次可连接一台平板。

## 在 MatePad 上试用

1. 在 Windows 电脑上按下方的[从源码运行](#从源码运行)启动程序。也可以先打包，再打开生成的 `Tablet-Link.exe`。移动免安装版时请保留整个文件夹。
2. 让电脑和平板接入同一个受信任的局域网。电脑可以连网线，平板连同一路由器的 Wi-Fi。
3. 在电脑上选中要共享的屏幕和连接平板的网卡，点击 **开始共享**。
4. 用 MatePad 扫描二维码，或在平板浏览器打开桌面端显示的完整 `http://` 链接。点击 **请求观看**，再在电脑上点击 **允许连接**。
5. 将平板横过来，点击 **全屏**。全屏时轻触画面可显示或隐藏控件和视频参数。退出请点击电脑上的 **停止共享**。

采集上限为 1920 × 1250 和 30 FPS，实际值由源屏幕、网络及浏览器决定。静止画面可能只需传送少量帧。

默认保留完整桌面。源屏幕和平板的宽高比不同时会留边。可以把虚拟显示器的分辨率设为接近平板宽高比的模式，部分 MatePad 11.5 机型适合 1920 × 1250。也可在接收页选择 **铺满画面（裁边）**，再次点击恢复完整画面。

## 使用扩展副屏

1. 让 Windows 识别第二块显示器。仅使用笔记本和平板时，可先用上游 Virtual Driver Control 为 Windows 添加一块虚拟显示器。选择它的 **Virtual Display Driver**，安装需管理员权限。 [Virtual Display Driver 官方发布页](https://github.com/VirtualDrivers/Virtual-Display-Driver/releases/tag/25.7.23)
2. 在平板智联选择 **扩展副屏**，打开 **Windows 显示设置**，选择把桌面扩展到这块显示器。Windows 也可通过 **Win + P → 扩展**切换显示模式。 [微软多显示器说明](https://support.microsoft.com/zh-cn/windows/hardware/display-graphics/how-to-use-multiple-monitors-in-windows)
3. 在平板智联选择这块扩展屏，开始共享并配对。把 Windows 窗口拖到扩展屏，平板上会显示该窗口。

平板智联会自动刷新屏幕列表。所选扩展屏断开或退出扩展模式时，共享会停止。虚拟显示器的创建和移除由安装的显示驱动管理。

### 页面打不开或连接失败

- 有多张网卡时，选连接平板所在网络的 Wi-Fi 或以太网地址。更换网络后，停止共享并刷新设备，再使用新二维码。
- 使用浏览器打开二维码中的完整链接，保留 `http://` 和 `#` 后的配对令牌。首版的接收页和连接信令使用局域网 HTTP/WebSocket，适合在受信任网络中测试。
- 如 Windows 防火墙提示，核对程序路径并仅为受信任的专用网络放行 `Tablet-Link.exe`。访客 Wi-Fi 可能隔离设备，可换用允许设备互访的网络。 [微软防火墙说明](https://support.microsoft.com/zh-cn/windows/security/firewall/risks-of-allowing-apps-through-windows-firewall)
- 平板显示等待确认时，在电脑上批准请求。如果显示已经连接但没有画面，保留两个界面的状态和 HarmonyOS、浏览器版本，便于定位。

## 从源码运行

在 Windows 上使用 Node.js 24 或更高版本。首次启动或打包时会下载 Electron 运行时。

```powershell
npm.cmd ci
npm.cmd start
```

```powershell
npm.cmd run check
npm.cmd test
npm.cmd run test:e2e
npm.cmd run package:win
```

端到端测试使用 Windows 的实际屏幕采集和本机另一个 Edge 进程，需有桌面会话及私有 IPv4 地址。扩展屏测试还需 Windows 已启用第二块扩展显示器。打包输出位于 `release/Tablet-Link-<版本>-win32-<架构>/`。

## 许可证

本项目采用 [MIT 许可证](LICENSE)。
