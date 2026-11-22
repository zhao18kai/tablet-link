# 平板智联

Windows 11 局域网屏幕共享原型。电脑采集选中的现有屏幕，MatePad 通过浏览器接收。每次连接需要在电脑上批准，一次可连接一台平板。

## 在 MatePad 上试用

1. 在 Windows 电脑上按下方的[从源码运行](#从源码运行)启动程序。也可以先打包，再打开生成的 `Tablet-Link.exe`。移动免安装版时请保留整个文件夹。
2. 让电脑和平板接入同一个受信任的局域网。电脑可以连网线，平板连同一路由器的 Wi-Fi。
3. 在电脑上选中要共享的屏幕和连接平板的网卡，点击 **开始共享**。
4. 用 MatePad 扫描二维码，或在平板浏览器打开桌面端显示的完整 `http://` 链接。点击 **请求观看**，再在电脑上点击 **允许连接**。
5. 将平板横过来，点击 **全屏**。查看文字、滚动和拖动窗口时的流畅度。浏览器顶部显示实际接收尺寸和解码帧率。退出请点击电脑上的 **停止共享**。

首版传输画面，采集上限为 1920 × 1250 和 30 FPS，实际值由源屏幕、网络及浏览器决定。静止画面可能只需传送少量帧。副屏扩展、声音与触控回传属于后续阶段。

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

端到端测试使用 Windows 的实际屏幕采集和本机另一个 Edge 进程，需有桌面会话及私有 IPv4 地址。打包输出位于 `release/Tablet-Link-win32-<架构>/`。

## 许可证

本项目采用 [MIT 许可证](LICENSE)。
