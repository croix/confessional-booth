# ============================================================================
#  Undo Harden-Booth.ps1 after the event (RUN AS ADMINISTRATOR).
# ============================================================================
$ErrorActionPreference = 'Continue'
Write-Host '=== Restore balanced power timeouts ==='
powercfg /change monitor-timeout-ac 10
powercfg /change standby-timeout-ac 30
powercfg /change disk-timeout-ac 20

Write-Host '=== USB selective suspend back ON ==='
$SUB_USB = '2a737441-1930-4402-8d77-b2bebba308a3'
$USB_SUS = '48e6b7a6-50f5-4782-a5d4-53bb8f07e226'
powercfg /setacvalueindex SCHEME_CURRENT $SUB_USB $USB_SUS 1
powercfg /setactive SCHEME_CURRENT

Write-Host '=== Re-enable Windows Update ==='
$AU = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU'
Remove-ItemProperty $AU -Name NoAutoUpdate -ErrorAction SilentlyContinue
Remove-ItemProperty $AU -Name AUOptions   -ErrorAction SilentlyContinue
foreach ($svc in 'wuauserv','UsoSvc') { try { Set-Service $svc -StartupType Manual; Start-Service $svc -ErrorAction SilentlyContinue } catch {} }
$UX = 'HKLM:\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings'
foreach ($n in 'PauseFeatureUpdatesStartTime','PauseFeatureUpdatesEndTime','PauseQualityUpdatesStartTime','PauseQualityUpdatesEndTime') { Remove-ItemProperty $UX -Name $n -ErrorAction SilentlyContinue }
Write-Host 'Defaults restored. Notifications/screensaver are per-user; re-enable in Settings if desired.'
