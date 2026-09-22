# ============================================================================
#  Confessional Booth - launcher & supervisor
#  Starts OBS, Companion and the controller, throws the branded output
#  fullscreen onto the booth monitor, then keeps everything alive and texts
#  you (via ntfy) if anything crashes or disk gets low.
#  Double-click the desktop shortcut, or it auto-starts at login.
# ============================================================================
$ErrorActionPreference = 'Continue'
$Proj      = 'C:\Users\DFWStreaming\Projects\confessional-booth'
$ObsExe    = 'C:\Program Files\obs-studio\bin\64bit\obs64.exe'
$ObsDir    = 'C:\Program Files\obs-studio\bin\64bit'
$CompExe   = 'C:\Program Files\Companion\Companion.exe'
$MonitorIx = 1                 # booth display (0 = operator/primary)
$LogDir    = Join-Path $Proj 'logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$cfg       = Get-Content (Join-Path $Proj 'config.json') -Raw | ConvertFrom-Json
$NotifyUrl = $cfg.notify.url
$Port      = $cfg.server.port
$DiskMinGB = 15

function Send-Alert($msg, $priority = 'high', $tags = 'rotating_light') {
  Write-Host "[ALERT] $msg"
  if ([string]::IsNullOrWhiteSpace($NotifyUrl)) { return }
  try { Invoke-RestMethod -Uri $NotifyUrl -Method Post -Body $msg -Headers @{ Title = 'Confessional Booth'; Priority = $priority; Tags = $tags } -TimeoutSec 8 | Out-Null } catch {}
}
function OBS-Up   { [bool](Get-Process obs64 -ErrorAction SilentlyContinue) }
function Comp-Up  { [bool](Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like 'C:\Program Files\Companion\*' } | Select-Object -First 1) }
function Ctrl-Up  { [bool](Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*src\index.js*' -or $_.CommandLine -like '*src/index.js*' } | Select-Object -First 1) }
function WS-Up    { Test-NetConnection -ComputerName 127.0.0.1 -Port 4455 -WarningAction SilentlyContinue -InformationLevel Quiet }

function Start-OBS {
  Start-Process -FilePath $ObsExe -ArgumentList @('--disable-shutdown-check','--disable-updater','--minimize-to-tray') -WorkingDirectory $ObsDir
  for ($i=0; $i -lt 30 -and -not (WS-Up); $i++) { Start-Sleep 1 }
}
function Start-Companion { if (-not (Comp-Up)) { Start-Process -FilePath $CompExe; Start-Sleep 6 } }
function Start-Controller {
  Start-Process -FilePath 'node' -ArgumentList 'src\index.js' -WorkingDirectory $Proj -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $LogDir 'controller.out.log') -RedirectStandardError (Join-Path $LogDir 'controller.err.log')
  Start-Sleep 3
}
function Open-Projector { & node (Join-Path $Proj 'scripts\open-projector.mjs') $MonitorIx 2>$null }

Write-Host '=== Booth supervisor starting ==='
if (-not (OBS-Up))  { Write-Host 'launching OBS...';        Start-OBS }        else { for ($i=0; $i -lt 30 -and -not (WS-Up); $i++){ Start-Sleep 1 } }
if (-not (Comp-Up)) { Write-Host 'launching Companion...';  Start-Companion }
if (-not (Ctrl-Up)) { Write-Host 'launching controller...'; Start-Controller }
Start-Sleep 3
Open-Projector
Send-Alert 'Booth is online and running.' 'default' 'white_check_mark'

$lastDiskAlert = (Get-Date).AddHours(-1)
while ($true) {
  Start-Sleep -Seconds 15
  try {
    if (-not (OBS-Up))  { Send-Alert 'OBS crashed - restarting.'; Start-OBS; Start-Sleep 3; Open-Projector }
    if (-not (Comp-Up)) { Send-Alert 'Companion crashed - restarting (deck may need a USB rescan).'; Start-Companion }
    if (-not (Ctrl-Up)) { Send-Alert 'Booth controller crashed - restarting.'; Start-Controller }
    # disk space on the recordings drive
    $drive = (Get-Item (Join-Path $Proj 'recordings')).PSDrive.Name
    $freeGB = [math]::Round((Get-PSDrive $drive).Free / 1GB, 1)
    if ($freeGB -lt $DiskMinGB -and (Get-Date) -gt $lastDiskAlert.AddMinutes(30)) {
      Send-Alert "Low disk space: $freeGB GB free on $drive`:" 'high' 'floppy_disk'
      $lastDiskAlert = Get-Date
    }
  } catch { Write-Host "supervisor loop error: $($_.Exception.Message)" }
}
