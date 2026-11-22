import { common } from '@kit.AbilityKit'
import { preferences } from '@kit.ArkData'
import { window } from '@kit.ArkUI'
import { webview } from '@kit.ArkWeb'
import { scanBarcode, scanCore } from '@kit.ScanKit'
import { ComputerDiscovery } from '../connect/ComputerDiscovery'
import { approvedComputer, buildReconnectUrl, DiscoveredComputer, parsePairingUrl, readRememberedComputers,
  RememberedComputer, rememberComputer } from '../connect/PairingUrl'

const historyKey = 'computers'
const bridgeName = 'tabletLinkReceiver'

class ReceiverBridge {
  private readonly onApproval: (id: string, name: string, token: string) => void

  constructor(onApproval: (id: string, name: string, token: string) => void) {
    this.onApproval = onApproval
  }

  rememberComputer(id: string, name: string, token: string): void {
    this.onApproval(id, name, token)
  }
}

@Entry
@Component
struct Index {
  @State private input: string = ''
  @State private destination: string = ''
  @State private message: string = ''
  @State private loadFailed: boolean = false
  @State private scanning: boolean = false
  @State private viewingFullScreen: boolean = false
  @State private remembered: RememberedComputer[] = []
  @State private available: DiscoveredComputer[] = []
  @State private discoveryFailed: boolean = false
  @State private historyFailed: boolean = false
  private controller: webview.WebviewController = new webview.WebviewController()
  private exitHandler: FullScreenExitHandler | null = null
  private history: preferences.Preferences | null = null
  private bridge: ReceiverBridge | null = null
  private discovery: ComputerDiscovery = new ComputerDiscovery(
    (computers: DiscoveredComputer[]) => { this.available = computers },
    () => { this.discoveryFailed = true },
  )

  aboutToAppear(): void {
    const context = this.getUIContext().getHostContext()
    if (!context) return
    try {
      this.history = preferences.getPreferencesSync(context, { name: 'tablet_link' })
      const saved = this.history.getSync(historyKey, '')
      if (typeof saved === 'string') this.remembered = readRememberedComputers(saved)
    } catch {
      this.historyFailed = true
    }
  }

  onPageShow(): void {
    if (!this.destination) this.startDiscovery()
  }

  onPageHide(): void {
    this.discovery.stop()
  }

  aboutToDisappear(): void {
    this.discovery.stop()
    this.detachBridge()
  }

  private startDiscovery(): void {
    this.discoveryFailed = false
    const context = this.getUIContext().getHostContext()
    if (!context) return
    const ids = this.remembered.map((computer: RememberedComputer) => computer.id)
    this.discovery.start(context as common.Context, new Set<string>(ids))
  }

  private connect(input: string): void {
    const link = parsePairingUrl(input)
    if (!link) {
      this.message = '请使用电脑端「开始共享」后生成的二维码或完整链接。'
      return
    }
    this.openViewer(link)
  }

  private reconnect(computer: RememberedComputer): void {
    const service = this.available.find((found: DiscoveredComputer) => found.id === computer.id)
    if (!service) return
    const link = buildReconnectUrl(service.address, service.port, computer.token)
    if (link) this.openViewer(link, computer.id)
  }

  private openViewer(link: string, rememberedId: string = ''): void {
    const controller = new webview.WebviewController()
    this.controller = controller
    this.bridge = new ReceiverBridge((id: string, name: string, token: string) => {
      if (this.controller !== controller || this.destination !== link || (rememberedId && rememberedId !== id)) return
      this.saveComputer(id, name, token)
    })
    this.discovery.stop()
    this.message = ''
    this.loadFailed = false
    this.destination = link
  }

  private saveComputer(id: string, name: string, token: string): void {
    const approved = approvedComputer(id, name, token)
    if (!approved) return
    const recent = this.remembered[0]
    if (recent && recent.id === id && recent.name === approved.name && recent.token === token && !this.historyFailed) {
      return
    }
    this.remembered = rememberComputer(this.remembered, approved)
    if (!this.history) return
    try {
      this.history.putSync(historyKey, JSON.stringify(this.remembered))
      this.history.flushSync()
      this.historyFailed = false
    } catch {
      this.historyFailed = true
    }
  }

  private attachBridge(): void {
    if (!this.bridge) return
    const authority = this.destination.slice('http://'.length).split('/')[0].split(':')
    const permission = '{"javascriptProxyPermission":{"urlPermissionList":[' +
      `{"scheme":"http","host":"${authority[0]}","port":"${authority[1]}","path":""}]}}`
    try {
      this.controller.registerJavaScriptProxy(this.bridge, bridgeName, ['rememberComputer'], [], permission)
    } catch {
      this.historyFailed = true
    }
  }

  private detachBridge(): void {
    if (!this.bridge) return
    try {
      this.controller.deleteJavaScriptRegister(bridgeName)
    } catch {
      // A Web controller may have already been detached by the system.
    }
    this.bridge = null
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
    this.detachBridge()
    this.destination = ''
    this.loadFailed = false
    this.input = ''
    this.startDiscovery()
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

  private isAvailable(id: string): boolean {
    return this.available.some((computer: DiscoveredComputer) => computer.id === id)
  }

  @Builder
  private recentComputers() {
    Column({ space: 8 }) {
      Text('最近连接').fontSize(18).fontWeight(FontWeight.Medium).fontColor('#14231D')
      ForEach(this.remembered, (computer: RememberedComputer) => {
        Button() {
          Row({ space: 12 }) {
            Text(computer.name).fontSize(16).fontColor('#164433')
              .layoutWeight(1).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
            Text(this.isAvailable(computer.id) ? '连接' : '未发现')
              .fontSize(14).fontColor('#40534B')
          }
          .width('100%').padding({ left: 16, right: 16 })
        }
        .width('100%').height(48).backgroundColor('#DDEAE3').type(ButtonType.Normal).borderRadius(12)
        .enabled(this.isAvailable(computer.id)).onClick(() => { this.reconnect(computer) })
      }, (computer: RememberedComputer): string => computer.id)
      if (this.discoveryFailed) {
        Text('暂时无法搜索局域网，可扫码或粘贴连接链接。').fontSize(14).fontColor('#40534B').lineHeight(21)
      }
    }
    .width('100%').alignItems(HorizontalAlign.Start)
  }

  @Builder
  private connectPage() {
    Scroll() {
      Column({ space: 16 }) {
        Text('平板智联').fontSize(30).fontWeight(FontWeight.Bold).fontColor('#14231D')
        Text('在 Windows 电脑上开始共享，两台设备接入同一个局域网。')
          .fontSize(16).fontColor('#40534B').lineHeight(23)
        if (this.remembered.length > 0) {
          this.recentComputers()
        }
        if (this.historyFailed) {
          Text('暂时无法保存最近连接，可扫码或粘贴连接链接。').fontSize(14).fontColor('#40534B').lineHeight(21)
        }
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
        .onControllerAttached(() => { this.attachBridge() })
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
