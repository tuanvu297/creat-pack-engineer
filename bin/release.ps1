param([Parameter(ValueFromRemainingArguments=$true)][string[]]$ReleaseArgs)
& python (Join-Path $PSScriptRoot 'release.py') @ReleaseArgs
exit $LASTEXITCODE
