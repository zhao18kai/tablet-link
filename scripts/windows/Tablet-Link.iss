[Setup]
AppId={{7B36DA90-8D5A-45C3-A31D-7FB46E1CC3B6}
AppName=Tablet Link
AppVersion={#AppVersion}
DefaultDirName={autopf}\Tablet Link
DefaultGroupName=Tablet Link
UninstallDisplayIcon={app}\Tablet-Link.exe
OutputBaseFilename=Tablet-Link-{#AppVersion}-Setup-{#AppArchitecture}
ArchitecturesAllowed={#WindowsArchitecture}
ArchitecturesInstallIn64BitMode={#WindowsArchitecture}
MinVersion=10.0.22000
PrivilegesRequired=admin
Compression=lzma2/fast
SolidCompression=yes
WizardStyle=modern
SetupLogging=yes

[Files]
Source: "{#AppSource}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#VddDriver}\MttVDD.inf"; DestDir: "{tmp}\tablet-link-vdd\driver"; Flags: deleteafterinstall
Source: "{#VddDriver}\mttvdd.cat"; DestDir: "{tmp}\tablet-link-vdd\driver"; Flags: deleteafterinstall
Source: "{#VddDriver}\MttVDD.dll"; DestDir: "{tmp}\tablet-link-vdd\driver"; Flags: deleteafterinstall
Source: "{#VddDriver}\vdd_settings.xml"; DestDir: "{tmp}\tablet-link-vdd\driver"; Flags: deleteafterinstall
Source: "{#VddPayload}\nefconc.exe"; DestDir: "{tmp}\tablet-link-vdd"; Flags: deleteafterinstall
Source: "install-vdd.ps1"; DestDir: "{tmp}\tablet-link-vdd"; Flags: deleteafterinstall
Source: "{#VddPayload}\*-LICENSE.txt"; DestDir: "{app}\licenses"
Source: "..\..\LICENSE"; DestDir: "{app}\licenses"; DestName: "Tablet-Link-LICENSE.txt"

[Icons]
Name: "{group}\Tablet Link"; Filename: "{app}\Tablet-Link.exe"
Name: "{autodesktop}\平板智联"; Filename: "{app}\Tablet-Link.exe"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "创建平板智联桌面快捷方式"

[Run]
Filename: "{app}\Tablet-Link.exe"; Description: "打开平板智联"; Flags: nowait postinstall skipifsilent runasoriginaluser

[Code]
procedure CurStepChanged(CurStep: TSetupStep);
var
  DriverExitCode: Integer;
  Params: String;
begin
  if CurStep <> ssPostInstall then Exit;

  WizardForm.StatusLabel.Caption := '正在安装 VDD 虚拟显示驱动…';
  Params := '-NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "' +
    ExpandConstant('{tmp}\tablet-link-vdd\install-vdd.ps1') + '" -DisplayHelper "' +
    ExpandConstant('{app}\resources\app\dist\tablet-pointer.exe') + '"';
  if not ExecAndLogOutput(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    Params, '', SW_HIDE, ewWaitUntilTerminated, DriverExitCode, nil) then
  begin
    Log('Could not start VDD setup. Windows error: ' + IntToStr(DriverExitCode));
    SuppressibleMsgBox('平板智联已安装，但无法启动 VDD 驱动安装。请重新运行安装程序。', mbError, MB_OK, IDOK);
  end
  else if DriverExitCode = 10 then
    SuppressibleMsgBox('VDD 驱动已安装。请在 Windows 显示设置中对 VDD by MTT 选择「断开此显示器」以启用自动副屏。',
      mbInformation, MB_OK, IDOK)
  else if DriverExitCode <> 0 then
  begin
    Log('VDD setup failed. Exit code: ' + IntToStr(DriverExitCode));
    SuppressibleMsgBox('平板智联已安装，但 VDD 驱动安装失败。请查看安装日志后重试。', mbError, MB_OK, IDOK);
  end;
end;
