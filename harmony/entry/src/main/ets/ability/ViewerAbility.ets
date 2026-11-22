import { UIAbility } from '@kit.AbilityKit'
import { window } from '@kit.ArkUI'
import { hilog } from '@kit.PerformanceAnalysisKit'

export default class ViewerAbility extends UIAbility {
  onWindowStageCreate(stage: window.WindowStage): void {
    void stage.loadContent('pages/Index').then(() => {
      AppStorage.setOrCreate('viewerWindow', stage.getMainWindowSync())
    }).catch(() => {
      hilog.error(0, 'TabletLink', 'Unable to open the viewer page')
    })
  }
}
