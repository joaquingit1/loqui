<#
PRD-8 — Windows self-update helper.

Invoked DETACHED by the app right before it quits (see
apps/desktop/src/main/updater/helper.ts -> resolveHelperPlan). It:
  1. Waits for the parent PID (the app that is quitting) to fully exit, so no
     file in the install dir is locked when we swap.
  2. Replaces the installed app folder's contents with the freshly-downloaded,
     sha256-VERIFIED, extracted staged tree (the parent verified integrity before
     spawning us; we only move bytes that already passed the check).
  3. Relaunches the new version via Start-Process and exits.

The swap is done as: move the old install dir aside, copy the staged tree into a
fresh install dir, then remove the aside after the copy succeeds. We copy rather
than move across-volume so a staging dir on a different drive still works.
SmartScreen may warn on an unsigned relaunch but does NOT hard-block (PRD-8).

Args (named, from the app):
  -ParentPid       the app PID to wait on before swapping
  -StagedPath      the extracted new-version tree (its contents replace InstallPath)
  -InstallPath     the installed app directory to replace
  -RelaunchTarget  the executable to launch after the swap (the new Loqui.exe)
#>
param(
  [Parameter(Mandatory = $true)][int]$ParentPid,
  [Parameter(Mandatory = $true)][string]$StagedPath,
  [Parameter(Mandatory = $true)][string]$InstallPath,
  [Parameter(Mandatory = $true)][string]$RelaunchTarget
)

$ErrorActionPreference = 'Stop'

function Wait-ForParentExit {
  param([int]$ProcessId, [int]$TimeoutSec = 60)
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($null -eq $proc) { return $true }
    Start-Sleep -Milliseconds 200
  }
  return $false
}

# 1. Wait for the app to exit so its files are unlocked.
[void](Wait-ForParentExit -ProcessId $ParentPid)

# A short settle so the OS releases file handles after the process object is gone.
Start-Sleep -Milliseconds 300

# 2. Swap: move the current install aside, then copy the staged tree into a fresh
#    install dir. Restore the aside if the copy fails.
$oldAside = "$InstallPath.old-$PID"
if (Test-Path -LiteralPath $oldAside) {
  Remove-Item -LiteralPath $oldAside -Recurse -Force
}
if (Test-Path -LiteralPath $InstallPath) {
  Move-Item -LiteralPath $InstallPath -Destination $oldAside
}

$swapSucceeded = $false
try {
  New-Item -ItemType Directory -Path $InstallPath -Force | Out-Null

  $robocopyArgs = @($StagedPath, $InstallPath, '/MIR', '/NFL', '/NDL', '/NJH', '/NJS', '/R:5', '/W:1')
  $proc = Start-Process -FilePath 'robocopy.exe' -ArgumentList $robocopyArgs -Wait -PassThru -NoNewWindow
  if ($proc.ExitCode -ge 8) {
    throw "robocopy failed with exit code $($proc.ExitCode)"
  }

  $swapSucceeded = $true
} finally {
  if ($swapSucceeded) {
    if (Test-Path -LiteralPath $oldAside) {
      Remove-Item -LiteralPath $oldAside -Recurse -Force
    }
  } else {
    if (Test-Path -LiteralPath $InstallPath) {
      Remove-Item -LiteralPath $InstallPath -Recurse -Force
    }
    if (Test-Path -LiteralPath $oldAside) {
      Move-Item -LiteralPath $oldAside -Destination $InstallPath
    }
  }
}

# 3. Relaunch the new version, then exit. Resolve the target inside the freshly
#    swapped install dir when the passed target lives there.
$target = $RelaunchTarget
if (-not (Test-Path -LiteralPath $target)) {
  $leaf = Split-Path -Leaf $RelaunchTarget
  $candidate = Join-Path $InstallPath $leaf
  if (Test-Path -LiteralPath $candidate) { $target = $candidate }
}
if (Test-Path -LiteralPath $target) {
  Start-Process -FilePath $target | Out-Null
}
