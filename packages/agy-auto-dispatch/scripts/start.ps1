param([Parameter(Mandatory=$true)][string]$State,[Parameter(Mandatory=$true)][string]$Config,[string]$Python='python')
$ErrorActionPreference='Stop'
$agyRoot=Split-Path $PSScriptRoot -Parent
$agyState=[IO.Path]::GetFullPath($State)
$agyConfig=[IO.Path]::GetFullPath($Config)
if(-not (Test-Path -LiteralPath $agyConfig -PathType Leaf)){throw 'Config must exist outside package'}
if($agyState.StartsWith($agyRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Private state must be outside package'}
New-Item -ItemType Directory -Path $agyState -Force | Out-Null
if(Test-Path -LiteralPath (Join-Path $agyState 'STOP')){throw 'STOP exists; retain it as evidence and use scripts/restart.ps1 for an intentional restart'}
$agyPython=(Get-Command $Python -ErrorAction Stop).Source
$agyDaemon=Join-Path $agyRoot 'src\daemon.py'
$agyArgs=@('-B', ('"'+$agyDaemon+'"'),'--state',('"'+$agyState+'"'),'--config',('"'+$agyConfig+'"'))
$agyStamp=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$agyProcess=Start-Process -FilePath $agyPython -ArgumentList $agyArgs -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $agyState ('daemon-'+$agyStamp+'.stdout.log')) -RedirectStandardError (Join-Path $agyState ('daemon-'+$agyStamp+'.stderr.log'))
[pscustomobject]@{status='PROCESS_STARTED_NOT_EXECUTOR_ACK';pid=$agyProcess.Id;state=$agyState}|ConvertTo-Json -Compress
