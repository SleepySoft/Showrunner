param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Enable', 'Disable')]
    [string]$Action
)

$ErrorActionPreference = 'Stop'
$taskName = 'Showrunner'
$root = Split-Path -Parent $PSScriptRoot
$node = Join-Path $root 'runtime\node\node.exe'
$server = Join-Path $root 'src\server.js'

try {
    if ($Action -eq 'Enable') {
        if (-not (Test-Path -LiteralPath $node)) {
            throw "Bundled Node.js was not found: $node"
        }
        if (-not (Test-Path -LiteralPath $server)) {
            throw "Showrunner server was not found: $server"
        }

        # The scheduled task runs Node directly. PowerShell is only the setup tool.
        $taskCommand = '"' + $node + '" "' + $server + '"'
        & schtasks.exe /Create /TN $taskName /SC ONLOGON /RL LIMITED /F /TR $taskCommand
        if ($LASTEXITCODE -ne 0) { throw "schtasks.exe failed with exit code $LASTEXITCODE" }

        Write-Host ''
        Write-Host 'Showrunner autostart is enabled.' -ForegroundColor Green
        Write-Host 'It will start after the current Windows user signs in.'
        Write-Host 'Run autostart-off.bat to disable it.'
    } else {
        & schtasks.exe /Query /TN $taskName *> $null
        if ($LASTEXITCODE -eq 0) {
            & schtasks.exe /Delete /TN $taskName /F
            if ($LASTEXITCODE -ne 0) { throw "schtasks.exe failed with exit code $LASTEXITCODE" }
            Write-Host ''
            Write-Host 'Showrunner autostart is disabled.' -ForegroundColor Green
        } else {
            Write-Host 'Showrunner autostart is already disabled.'
        }
    }
    exit 0
} catch {
    Write-Host ''
    Write-Host ("Autostart setup failed: " + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
