param([Parameter(Mandatory=$true)][string]$State,[Parameter(Mandatory=$true)][string]$Config,[string]$Python='python')
$ErrorActionPreference='Stop'
$agyState=[IO.Path]::GetFullPath($State)
$agyStop=Join-Path $agyState 'STOP'
if(Test-Path -LiteralPath $agyStop){Move-Item -LiteralPath $agyStop -Destination (Join-Path $agyState ('STOP-HISTORY-'+[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()))}
& (Join-Path $PSScriptRoot 'start.ps1') -State $agyState -Config $Config -Python $Python
