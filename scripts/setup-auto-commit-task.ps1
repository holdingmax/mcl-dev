## Setup Windows Task Scheduler for MCL-WMS daily auto-commit
## Run this script once in PowerShell (as your user, not admin needed)

$action = New-ScheduledTaskAction `
    -Execute "C:\Program Files\Git\usr\bin\bash.exe" `
    -Argument "C:/Users/dgarc/Downloads/Agentes MCL/mcl-wms/scripts/auto-commit-local.sh"

$trigger = New-ScheduledTaskTrigger -Daily -At "11:55PM"

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable

Register-ScheduledTask `
    -TaskName "MCL-WMS Auto Commit" `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description "Daily auto-commit and push of mcl-wms repo changes" `
    -Force

Write-Host "`nTask created. Verify with:" -ForegroundColor Green
Write-Host "  schtasks /query /tn 'MCL-WMS Auto Commit' /v /fo list" -ForegroundColor Cyan
