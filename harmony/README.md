# 平板智联 · 鸿蒙 7 接收端

鸿蒙 7.0 平板可从桌面打开此 App，扫描 Windows 端生成的二维码，也可粘贴完整链接。电脑批准后，App 内的 ArkWeb 组件通过现有 WebRTC 协议显示扩展屏。应用声明了全屏、分屏和悬浮窗模式，实际可用的窗口模式由平板系统决定。

首次连接获电脑批准后，App 会保存这台电脑。下次两台设备在同一局域网，且电脑已经开始共享时，在 App 首页的「最近连接」点按这台电脑即可直接连接。收到画面后会自动进入全屏，按系统返回键或点「退出全屏」可返回窗口模式。若未找到电脑，仍可扫码或粘贴链接。

ArkWeb 使用私有 IPv4 地址通过 HTTP 连接 Windows 端，请使用受信任的局域网。 [华为网络配置说明](https://developer.huawei.com/consumer/en/doc/HarmonyOS-Guides/http-request/)

## 构建和安装

在 DevEco Studio 的 API `26.0.0` 环境中打开 `harmony` 工程，然后构建 `entry` HAP。华为构建工具要求工程路径使用英文字符，若项目位于中文目录，先把 `harmony` 复制到 `D:\TabletLinkDev\HarmonyViewer` 之类的路径。使用相同版本华为命令行工具时，可在该工程目录执行下方命令。

```powershell
ohpm install --all
hvigorw assembleHap --mode module -p product=default -p module=entry@default -p buildMode=debug --no-daemon
```

发布页提供的未签名 HAP 需要签名才能安装到平板。在 DevEco Studio 中连接已启用 USB 调试的平板，然后在 Project Structure 的 Signing Configs 中生成调试签名。签名文件保存在 Git 仓库以外，提交前检查 `build-profile.json5` 中的本地签名配置。 [华为构建指南](https://developer.huawei.com/consumer/en/doc/doccenter-deveco-studio/ide-command-line-building-app/) · [华为自动签名指南](https://developer.huawei.com/consumer/en/doc/harmonyos-guides/ide-signing-auto/)

## 真机验证

1. 让平板和 Windows 电脑接入同一局域网。电脑上选择 **扩展副屏**。使用 VDD 虚拟副屏时，在共享屏幕列表里选择 **VDD by MTT · 扩展屏**。确认 **允许平板触控** 已勾选，然后开始共享。
2. 在 App 内扫码并请求观看。电脑批准后，确认画面、点击、拖窗和双指滚动。
3. 进入全屏再退出，尝试系统分屏或悬浮窗。切到平板上的笔记等应用，再返回查看副屏能否继续播放。
4. 关闭 Wi-Fi 约 5 秒再打开，检查画面与触控是否恢复。
5. 返回 App 首页并重新打开 App。确认已批准的电脑仍在「最近连接」，开始共享后显示「连接」。点按后确认画面自动出现并进入全屏，退出全屏时确认串流继续。停止共享后，确认这台电脑显示「未发现」。
