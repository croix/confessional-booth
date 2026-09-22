# ============================================================================
#  Rebuild the Stream Deck layout — run after changing the crest in /admin, or
#  to re-apply the deck design (e.g. redeploying for a new wedding).
# ============================================================================
$ErrorActionPreference = 'Continue'
$Proj = 'C:\Users\DFWStreaming\Projects\confessional-booth'

Write-Host 'Rendering the gold crest for the deck keys...'
node "$Proj\scripts\render-crest.mjs"

Write-Host 'Stopping Companion...'
Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like 'C:\Program Files\Companion\*' } |
  ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch {} }
Start-Sleep -Seconds 4

Write-Host 'Writing the deck layout...'
node "$Proj\scripts\gen-deck.mjs"

Write-Host 'Starting Companion...'
Start-Process -FilePath 'C:\Program Files\Companion\Companion.exe'
for ($i = 0; $i -lt 40; $i++) { Start-Sleep 1; if (Test-NetConnection -ComputerName 127.0.0.1 -Port 8888 -WarningAction SilentlyContinue -InformationLevel Quiet) { break } }

Write-Host ''
Write-Host 'Done. If the physical deck stays blank, open Companion (http://127.0.0.1:8888)'
Write-Host ' -> Surfaces -> Rescan USB.'
