param([Parameter(Mandatory = $true)][string]$DisplayHelper)

$ErrorActionPreference = 'Stop'

function Get-VddDevices {
    Get-CimInstance -ClassName Win32_PnPEntity -Filter 'Present = TRUE' |
        Where-Object { $_.HardwareID -contains 'Root\MttVDD' }
}

try {
    $devices = @(Get-VddDevices)
    if ($devices | Where-Object ConfigManagerErrorCode -eq 0) {
        Write-Output 'VDD is already installed. Keeping its current configuration.'
        exit 0
    }

    $driver = Join-Path $PSScriptRoot 'driver'
    $inf = Join-Path $driver 'MttVDD.inf'
    $catalog = Join-Path $driver 'mttvdd.cat'
    $installer = Join-Path $PSScriptRoot 'nefconc.exe'
    if (-not ((Test-Path -LiteralPath $inf) -and (Test-Path -LiteralPath $catalog) -and (Test-Path -LiteralPath $installer))) {
        throw 'Bundled VDD files are missing.'
    }
    if ((Get-AuthenticodeSignature -LiteralPath $catalog).Status -ne 'Valid' -or
        (Get-AuthenticodeSignature -LiteralPath $installer).Status -ne 'Valid') {
        throw 'VDD or Nefcon signature validation failed.'
    }

    $settings = 'C:\VirtualDisplayDriver\vdd_settings.xml'
    if (-not (Test-Path -LiteralPath $settings)) {
        New-Item -ItemType Directory -Path (Split-Path -Parent $settings) -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $driver 'vdd_settings.xml') -Destination $settings
    }

    if ($devices.Count -eq 0) {
        & $installer install $inf 'Root\MttVDD'
    } else {
        # Reuse the device node from an incomplete install instead of creating another one.
        & (Join-Path $env:SystemRoot 'System32\pnputil.exe') /add-driver $inf /install
    }
    if ($LASTEXITCODE -ne 0) { throw "VDD driver installer returned $LASTEXITCODE." }

    for ($attempt = 0; $attempt -lt 25; $attempt++) {
        & $DisplayHelper --prepare-vdd-standby
        if ($LASTEXITCODE -eq 0) {
            Write-Output 'VDD standby display is ready.'
            exit 0
        }
        if ($LASTEXITCODE -eq 12) { break }
        Start-Sleep -Milliseconds 400
    }

    if (-not (Get-VddDevices | Where-Object ConfigManagerErrorCode -eq 0)) { throw 'Windows has not started the VDD device.' }
    Write-Output 'VDD is installed, but Windows did not expose a standby display.'
    exit 10
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
