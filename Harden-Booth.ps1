# ============================================================================
#  Event-day hardening (RUN AS ADMINISTRATOR).
#  Reverse it with Restore-Defaults.ps1 after the event.
# ============================================================================
$ErrorActionPreference = 'Continue'
Write-Host '=== Power: never sleep / never turn off display / no disk timeout ==='
powercfg /change monitor-timeout-ac 0
powercfg /change monitor-timeout-dc 0
powercfg /change standby-timeout-ac 0
powercfg /change standby-timeout-dc 0
powercfg /change disk-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /hibernate off | Out-Null

Write-Host '=== USB selective suspend OFF (keeps ATEM + Stream Deck alive) ==='
$SUB_USB = '2a737441-1930-4402-8d77-b2bebba308a3'
$USB_SUS = '48e6b7a6-50f5-4782-a5d4-53bb8f07e226'
powercfg /setacvalueindex SCHEME_CURRENT $SUB_USB $USB_SUS 0
powercfg /setdcvalueindex SCHEME_CURRENT $SUB_USB $USB_SUS 0
powercfg /setactive SCHEME_CURRENT

Write-Host '=== Windows Update: pause + disable service (no forced reboot) ==='
$AU = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU'
New-Item -Path $AU -Force | Out-Null
Set-ItemProperty $AU -Name NoAutoUpdate -Value 1 -Type DWord
Set-ItemProperty $AU -Name AUOptions   -Value 1 -Type DWord
foreach ($svc in 'wuauserv','UsoSvc') {
  try { Stop-Service $svc -Force -ErrorAction SilentlyContinue; Set-Service $svc -StartupType Disabled } catch {}
}
$UX = 'HKLM:\SOFTWARE\Microsoft\WindowsUpdate\UX\Settings'
New-Item -Path $UX -Force | Out-Null
$now = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
$end = (Get-Date).AddDays(35).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
foreach ($n in 'PauseFeatureUpdatesStartTime','PauseQualityUpdatesStartTime') { Set-ItemProperty $UX -Name $n -Value $now -ErrorAction SilentlyContinue }
foreach ($n in 'PauseFeatureUpdatesEndTime','PauseQualityUpdatesEndTime')   { Set-ItemProperty $UX -Name $n -Value $end -ErrorAction SilentlyContinue }

Write-Host ''
Write-Host '=== RESULT ==='
Get-Service wuauserv | Select-Object Name, Status, StartType | Format-Table -AutoSize
Write-Host 'Hardening applied. Reverse with Restore-Defaults.ps1 after the event.'
