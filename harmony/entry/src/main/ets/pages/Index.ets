import { window } from '@kit.ArkUI'
import { webview } from '@kit.ArkWeb'
import { scanBarcode, scanCore } from '@kit.ScanKit'
import { parsePairingUrl } from '../connect/PairingUrl'

@Entry
@Component
struct Index {
  @State private input: string = ''
  @State private destination: string = ''
  @State private message: string = ''
  @State private loadFailed: boolean = false
  @State private scanning: boolean = false
  @State private viewingFullScreen: boolean = false
  private controller: webview.WebviewController = new webview.WebviewController()
  private exitHandler: FullScreenExitHandler | null = null

  private connect(input: string): void {
    const link = parsePairingUrl(input)
    if (!link) {
      this.message = '请使用电脑端「开始共享」后生成的二维码或完整链接。'
      return
    }
    this.controller = new webview.WebviewController()
    this.input = link
    this.message = ''
    this.loadFailed = false
    this.destination = link
  }

  private async scan(): Promise<void> {
    const context = this.getUIContext().getHostContext()
    if (context === undefined || this.scanning) return
    this.scanning = true
    this.message = ''
    try {
      const options: scanBarcode.ScanOptions = {
        scanTypes: [scanCore.ScanType.QR_CODE],
        enableAlbum: false,
      }
      const result = await scanBarcode.startScanForResult(context, options)
      this.connect(result.originalValue)
    } catch {
      this.message = '扫码未完成，可以重试或粘贴连接链接。'
    } finally {
      this.scanning = false
    }
  }

  private async updateWindow(): Promise<void> {
    const mainWindow = AppStorage.get<window.Window>('viewerWindow')
    if (!mainWindow) return
    try {
      if (mainWindow.getWindowStatus() !== window.WindowStatusType.FULL_SCREEN) return
      await mainWindow.setWindowLayoutFullScreen(this.viewingFullScreen)
      await mainWindow.setWindowSystemBarEnable(this.viewingFullScreen ? [] : ['status', 'navigation'])
    } catch {
      // The Web component still fills its own window when the system controls the bars.
    }
  }

  private backToConnect(): void {
    this.viewingFullScreen = false
    this.exitHandler = null
    this.destination = ''
    this.loadFailed = false
    this.input = ''
    void this.updateWindow()
  }

  onBackPress(): boolean {
    if (this.exitHandler) {
      this.exitHandler.exitFullScreen()
      return true
    }
    if (this.destination) {
      this.backToConnect()
      return true
    }
    return false
  }

  @Builder
  private connectPage() {
    Scroll() {
      Column({ space: 16 }) {
        Text('平板智联').fontSize(30).fontWeight(FontWeight.Bold).fontColor('#14231D')
        Text('在 Windows 电脑上开始共享，两台设备接入同一个局域网。')
          .fontSize(16).fontColor('#40534B').lineHeight(23)
        Button('扫描电脑二维码')
          .width('100%').height(46).backgroundColor('#146048').fontColor('#FFFFFF')
          .enabled(!this.scanning).onClick(() => { void this.scan() })
        TextInput({ text: this.input, placeholder: '粘贴电脑端显示的完整链接' })
          .width('100%').type(InputType.Normal)
          .onChange((value: string) => { this.input = value; this.message = '' })
        Button('连接电脑')
          .width('100%').height(46).backgroundColor('#DDEAE3').fontColor('#164433')
          .enabled(this.input.trim().length > 0)
          .onClick(() => { this.connect(this.input) })
        if (this.message) {
          Text(this.message).fontSize(14).fontColor('#8C331D').lineHeight(21)
        }
      }
      .width('100%').constraintSize({ maxWidth: 480 })
      .alignItems(HorizontalAlign.Start).padding(24)
    }
    .width('100%').height('100%').align(Alignment.Top).backgroundColor('#EEF2EF')
  }

  @Builder
  private viewerPage() {
    Column() {
      if (!this.viewingFullScreen) {
        Row() {
          Button('返回连接').onClick(() => { this.backToConnect() })
          if (this.loadFailed) {
            Button('重新加载').onClick(() => {
              this.loadFailed = false
              this.controller.refresh()
            })
          }
        }
        .width('100%').padding({ left: 12, right: 12, top: 6, bottom: 6 })
        .justifyContent(FlexAlign.SpaceBetween)
        .backgroundColor('#EEF2EF')
      }
      if (this.loadFailed) {
        Text('请确认电脑仍在共享，并重新加载或重新扫码。')
          .width('100%').padding(12).fontColor('#8C331D').backgroundColor('#FFF1E9')
      }
      Web({ src: this.destination, controller: this.controller })
        .width('100%').layoutWeight(1)
        .javaScriptAccess(true).fileAccess(false).zoomAccess(false)
        .onLoadIntercept((event) => {
          if (!event || !event.data.isMainFrame()) return false
          const requested = event.data.getRequestUrl()
          return requested !== this.destination && requested !== this.destination.split('#')[0]
        })
        .onErrorReceive((event) => {
          if (event?.request.isMainFrame()) this.loadFailed = true
        })
        .onFullScreenEnter((event) => {
          this.exitHandler = event.handler
          this.viewingFullScreen = true
          void this.updateWindow()
        })
        .onFullScreenExit(() => {
          this.exitHandler = null
          this.viewingFullScreen = false
          void this.updateWindow()
        })
    }
    .width('100%').height('100%').backgroundColor('#101916')
  }

  build() {
    Column() {
      if (this.destination) {
        this.viewerPage()
      } else {
        this.connectPage()
      }
    }
    .width('100%').height('100%')
  }
}
