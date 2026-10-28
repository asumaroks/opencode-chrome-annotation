[CmdletBinding()]
param(
  [string]$WebDist = "C:\Users\Alex\AppData\Local\Programs\@openchamberelectron\resources\web-dist",
  [switch]$Apply,
  [switch]$Rollback,
  [string]$ExpectedSha256 = "",
  [switch]$Force
)

$ErrorActionPreference = "Stop"

$InstallRecordName = ".octm-install.json"
$BackupRootName = ".octm-backups"
$MarkerToken = "__octm"
$BootstrapFileNames = @("octm-config.js", "octm-fallback.js", "octm-bootstrap.js")
$ModuleFileNames = @("runtime.mjs", "index.mjs", "draft-controller.mjs", "mention-source.mjs", "bridge-client.mjs", "patch-manifest.mjs")
$IndexTags = @(
  '<script src="/octm-config.js"></script>',
  '<script src="/octm-fallback.js"></script>',
  '<script type="module" crossorigin src="/octm-bootstrap.js"></script>'
)

$script:NodeExe = $null

function Get-Sha256([string]$Path) {
  $algorithm = $null
  $stream = $null
  try {
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    $stream = [System.IO.File]::OpenRead($Path)
    $hash = $algorithm.ComputeHash($stream)
    return [System.BitConverter]::ToString($hash).Replace("-", "").ToLowerInvariant()
  } finally {
    if ($stream) { $stream.Dispose() }
    if ($algorithm) { $algorithm.Dispose() }
  }
}

function Get-BytesSha256([byte[]]$Bytes) {
  $algorithm = $null
  try {
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    $hash = $algorithm.ComputeHash($Bytes)
    return [System.BitConverter]::ToString($hash).Replace("-", "").ToLowerInvariant()
  } finally {
    if ($algorithm) { $algorithm.Dispose() }
  }
}

function Write-Line {
  param([string]$Text)
  [Console]::Out.WriteLine($Text)
}

function Refuse {
  param([string]$Message)
  Write-Line ("refused: " + $Message)
  Write-Line "result: refused"
  exit 1
}

function Get-ManifestPin {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { Refuse "the patch manifest is missing: $Path" }
  $text = [IO.File]::ReadAllText($Path)
  $versionMatch = [regex]::Match($text, 'version:\s*"([^"]+)"')
  $shaMatch = [regex]::Match($text, 'sha256:\s*"([0-9a-fA-F]{64})"')
  $version = $null
  $sha256 = $null
  if ($versionMatch.Success) { $version = $versionMatch.Groups[1].Value }
  if ($shaMatch.Success) { $sha256 = $shaMatch.Groups[1].Value.ToLowerInvariant() }
  return [pscustomobject]@{ Version = $version; Sha256 = $sha256 }
}

function Invoke-Node {
  param([string[]]$Arguments)
  $previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = (& $script:NodeExe @Arguments 2>&1 | Out-String).Trim()
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
  return [pscustomobject]@{ ExitCode = $exitCode; Output = $output }
}

function Join-WebPath {
  param([string]$Root, [string]$Relative)
  $parts = $Relative -split "/"
  $path = $Root
  foreach ($part in $parts) {
    if ($part) { $path = Join-Path $path $part }
  }
  return $path
}

function Resolve-InsideRoot {
  param([string]$Root, [string]$Path)
  if (-not $Path) { return $null }
  $full = $null
  try { $full = [IO.Path]::GetFullPath($Path) } catch { return $null }
  $rootFull = ([IO.Path]::GetFullPath($Root)).TrimEnd([char[]]@("\", "/"))
  $prefix = $rootFull + [IO.Path]::DirectorySeparatorChar
  if ($full.Length -le $prefix.Length) { return $null }
  if (-not $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { return $null }
  return $full
}

function Split-RecordPaths {
  param([string]$Root, $Record)
  $inside = @()
  $outside = @()
  $entries = @()
  if ($Record -and $Record.files) { $entries = @($Record.files) }
  foreach ($entry in $entries) {
    $path = [string]$entry.path
    if (-not $path) { continue }
    $full = Resolve-InsideRoot $Root $path
    if (-not $full) {
      if ($outside -notcontains $path) { $outside += $path }
      continue
    }
    $inside += [pscustomobject]@{ Path = $full; Sha256 = ([string]$entry.sha256).ToLowerInvariant() }
  }
  $added = @()
  if ($Record -and $Record.added) { $added = @($Record.added) }
  foreach ($path in $added) {
    if (-not $path) { continue }
    if (Resolve-InsideRoot $Root ([string]$path)) { continue }
    if ($outside -notcontains [string]$path) { $outside += [string]$path }
  }
  return [pscustomobject]@{ Inside = $inside; Outside = $outside }
}

function Write-OutsideNote {
  param([string]$Root, [string[]]$Outside, [switch]$LeftUntouched)
  $count = @($Outside).Count
  if ($count -eq 0) { return }
  $message = "note: ignored " + $count + " recorded path(s) outside " + [IO.Path]::GetFullPath($Root)
  if ($LeftUntouched) { $message = $message + "; they are left untouched" }
  Write-Line $message
}

function Get-RecordDrift {
  param($Entries)
  $drift = @()
  foreach ($entry in @($Entries)) {
    $path = [string]$entry.Path
    if (-not (Test-Path -LiteralPath $path)) {
      $drift += ($path + " (missing)")
      continue
    }
    $actual = Get-Sha256 $path
    if ($actual -ne [string]$entry.Sha256) { $drift += ($path + " (" + $actual + ")") }
  }
  return $drift
}

function Read-IndexText {
  param([byte[]]$Bytes)
  return [Text.Encoding]::UTF8.GetString($Bytes)
}

function Resolve-BackupCopy {
  param([string]$BackupDir, $Entry, [string]$Name)
  $direct = Join-Path $BackupDir $Name
  if (Test-Path -LiteralPath $direct -PathType Leaf) { return $direct }
  $recorded = [string]$Entry.backup
  if ($recorded) {
    $relative = (Join-Path $BackupDir ($recorded -replace "/", "\"))
    if (Test-Path -LiteralPath $relative -PathType Leaf) { return $relative }
  }
  $filesDir = Join-Path $BackupDir "files"
  if (Test-Path -LiteralPath $filesDir -PathType Container) {
    $candidates = @(Get-ChildItem -LiteralPath $filesDir -File | Where-Object { $_.Name -like ("*-" + $Name) })
    if ($candidates.Count -eq 1) { return $candidates[0].FullName }
  }
  return $null
}

function Get-PatchedIndex {
  param([string]$Text, [string]$EntryTag)
  $already = $true
  foreach ($tag in $IndexTags) {
    if ($Text.IndexOf($tag, [StringComparison]::Ordinal) -lt 0) { $already = $false }
  }
  if ($already) { return [pscustomobject]@{ Text = $Text; Inserted = $false } }

  $entryIndex = $Text.IndexOf($EntryTag, [StringComparison]::Ordinal)
  if ($entryIndex -lt 0) { Refuse "the entry script tag moved while reading index.html" }
  $newline = "`n"
  if ($Text.IndexOf("`r`n", [StringComparison]::Ordinal) -ge 0) { $newline = "`r`n" }
  $lineStart = $entryIndex
  $indent = ""
  $scan = $entryIndex - 1
  while ($scan -ge 0 -and ($Text[$scan] -eq " " -or $Text[$scan] -eq "`t")) { $scan-- }
  if ($scan -lt 0 -or $Text[$scan] -eq "`n" -or $Text[$scan] -eq "`r") {
    $lineStart = $scan + 1
    $indent = $Text.Substring($lineStart, $entryIndex - $lineStart)
  } else {
    $lineStart = $entryIndex
    $indent = ""
  }
  $insertion = ""
  foreach ($tag in $IndexTags) { $insertion = $insertion + $indent + $tag + $newline }
  return [pscustomobject]@{
    Text = $Text.Substring(0, $lineStart) + $insertion + $Text.Substring($lineStart)
    Inserted = $true
  }
}

function Invoke-Rollback {
  param([string]$Root)
  $recordPath = Join-Path $Root $InstallRecordName
  if (-not (Test-Path -LiteralPath $recordPath)) {
    Refuse "no install record at $recordPath, nothing to roll back"
  }
  $record = $null
  try {
    $record = Get-Content -Raw -LiteralPath $recordPath | ConvertFrom-Json
  } catch {
    Refuse "the install record is not valid JSON: $recordPath"
  }
  $recordPaths = Split-RecordPaths $Root $record
  Write-OutsideNote $Root $recordPaths.Outside -LeftUntouched
  $drift = @(Get-RecordDrift $recordPaths.Inside)
  if ($drift.Count -gt 0) {
    Refuse ("recorded files changed since the install: " + ($drift -join ", "))
  }
  $backupDir = [string]$record.backupDir
  if (-not $backupDir -or -not (Test-Path -LiteralPath $backupDir)) {
    Refuse "the recorded backup directory is missing: $backupDir"
  }
  $manifestPath = Join-Path $backupDir "manifest.json"
  if (-not (Test-Path -LiteralPath $manifestPath)) {
    Refuse "the backup manifest is missing: $manifestPath"
  }
  $backup = $null
  try {
    $backup = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
  } catch {
    Refuse "the backup manifest is not valid JSON: $manifestPath"
  }
  $originals = @()
  if ($backup -and $backup.files) { $originals = @($backup.files) }
  if ($originals.Count -eq 0) { Refuse "the backup manifest records no original files: $manifestPath" }
  $restorable = @()
  foreach ($entry in $originals) {
    $createdByInstall = $false
    if ($entry.PSObject.Properties.Name -contains "existed") { $createdByInstall = ($entry.existed -eq $false) }
    if ($createdByInstall) { continue }
    $target = Resolve-InsideRoot $Root ([string]$entry.path)
    if (-not $target) { continue }
    $name = [IO.Path]::GetFileName($target)
    $copy = Resolve-BackupCopy $backupDir $entry $name
    if (-not $copy) { Refuse ("the backup copy is missing for " + [string]$entry.path + " under " + $backupDir) }
    $expected = ([string]$entry.sha256).ToLowerInvariant()
    $actual = Get-Sha256 $copy
    if ($actual -ne $expected) { Refuse ("the backup copy does not match its recorded hash: " + $copy) }
    $restorable += [pscustomobject]@{ Path = $target; Copy = $copy }
  }
  foreach ($entry in $restorable) {
    $target = $entry.Path
    $temp = $target + ".octm-new"
    [IO.File]::WriteAllBytes($temp, [IO.File]::ReadAllBytes($entry.Copy))
    Move-Item -LiteralPath $temp -Destination $target -Force
    Write-Line ("restored: " + $target)
  }
  $added = @()
  if ($record.added) { $added = @($record.added) }
  $removed = 0
  foreach ($path in $added) {
    if (-not $path) { continue }
    $target = Resolve-InsideRoot $Root ([string]$path)
    if (-not $target) { continue }
    if (Test-Path -LiteralPath $target -PathType Leaf) {
      Remove-Item -LiteralPath $target -Force
      Write-Line ("removed: " + $target)
      $removed = $removed + 1
    } else {
      Write-Line ("skipped (not a file): " + $target)
    }
  }
  Remove-Item -LiteralPath $recordPath -Force
  Write-Line ("removed: " + $recordPath)
  Write-Line ("rollback: restored " + $restorable.Count + " file(s) and removed " + $removed + " added file(s)")
  Write-Line "note: restart OpenChamber (or reload the UI with cache bypass) to drop the adapter; a service-worker cache may still serve the patched asset until it is cleared."
  Write-Line "result: rollback-complete"
  exit 0
}

function Invoke-Install {
  param([string]$Root)

  if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
    Refuse "the web-dist directory does not exist: $Root"
  }

  $manifestPath = Join-Path $PSScriptRoot "..\integrations\openchamber\patch-manifest.mjs"
  $pin = Get-ManifestPin ([IO.Path]::GetFullPath($manifestPath))
  if (-not $pin.Sha256) { Refuse "the pinned asset hash could not be read from $manifestPath" }
  if (-not $pin.Version) { Refuse "the pinned app version could not be read from $manifestPath" }
  $pinned = $pin.Sha256
  $version = $pin.Version

  $expected = $pinned
  if ($ExpectedSha256) { $expected = $ExpectedSha256.Trim().ToLowerInvariant() }
  if ($expected -notmatch '^[0-9a-f]{64}$') { Refuse "-ExpectedSha256 must be a 64 character hex sha256 digest" }
  if ($expected -ne $pinned) {
    Write-Line ("OVERRIDE: -ExpectedSha256 " + $expected + " differs from the pinned pristine " + $pinned + " (test-only, not the audited build)")
  }

  $indexPath = Join-Path $Root "index.html"
  $assetsDir = Join-Path $Root "assets"
  $recordPath = Join-Path $Root $InstallRecordName
  $backupRoot = Join-Path $Root $BackupRootName
  if (-not (Test-Path -LiteralPath $indexPath -PathType Leaf)) { Refuse "index.html is missing: $indexPath" }
  if (-not (Test-Path -LiteralPath $assetsDir -PathType Container)) { Refuse "the assets directory is missing: $assetsDir" }

  $record = $null
  $recordPaths = $null
  if (Test-Path -LiteralPath $recordPath) {
    try {
      $record = Get-Content -Raw -LiteralPath $recordPath | ConvertFrom-Json
    } catch {
      Refuse "the existing install record is not valid JSON: $recordPath"
    }
    $recordedFiles = @()
    if ($record.files) { $recordedFiles = @($record.files) }
    if ($recordedFiles.Count -eq 0) { Refuse "the existing install record lists no files: $recordPath" }
    $recordPaths = Split-RecordPaths $Root $record
    Write-OutsideNote $Root $recordPaths.Outside
    $drift = @(Get-RecordDrift $recordPaths.Inside)
    if ($drift.Count -eq 0) {
      Write-Line ("status: already installed (version " + [string]$record.version + ")")
      Write-Line ("asset: " + [string]$record.assetSha256)
      Write-Line ("backup: " + [string]$record.backupDir)
      if (-not $Apply) { Write-Line "dry run: nothing was written" }
      Write-Line "result: already-installed"
      exit 0
    }
    if (-not $Force) {
      Refuse ("an install is recorded but these files changed since then: " + ($drift -join ", ") + " (use -Force to re-install)")
    }
    Write-Line ("force: re-installing over a recorded install with " + $drift.Count + " changed path(s)")
  }

  $indexBytes = [IO.File]::ReadAllBytes($indexPath)
  $indexText = Read-IndexText $indexBytes

  $entryPattern = '<script\b[^>]*\bsrc="(?<src>/assets/main-[A-Za-z0-9_-]+\.js)"[^>]*>\s*</script>'
  $entryMatches = [regex]::Matches($indexText, $entryPattern)
  if ($entryMatches.Count -ne 1) {
    Refuse ("index.html must reference exactly one /assets/main-*.js entry script, found " + $entryMatches.Count)
  }
  $entryTag = $entryMatches[0].Value
  if ($entryTag -notmatch 'type="module"') { Refuse "the /assets/main-*.js entry is not type=module" }
  $entrySrc = $entryMatches[0].Groups["src"].Value
  $entryPath = Join-WebPath $Root ($entrySrc.TrimStart("/"))
  if (-not (Test-Path -LiteralPath $entryPath -PathType Leaf)) { Refuse "the entry script is missing: $entryPath" }

  $entryText = [IO.File]::ReadAllText($entryPath)
  $importPattern = 'import\(\s*["''](?<spec>\./main-[A-Za-z0-9_-]+\.js)["'']\s*\)'
  $importMatches = [regex]::Matches($entryText, $importPattern)
  if ($importMatches.Count -ne 1) {
    Refuse ("the entry " + $entrySrc + " must dynamically import exactly one ./main-*.js app module, found " + $importMatches.Count)
  }
  $appSpec = $importMatches[0].Groups["spec"].Value
  $appName = $appSpec.Substring(2)
  $appPath = Join-Path $assetsDir $appName
  if (-not (Test-Path -LiteralPath $appPath -PathType Leaf)) {
    Refuse ("the entry imports " + $appSpec + " but " + $appPath + " does not exist")
  }
  Write-Line ("build: entry " + $entrySrc + " -> app module " + $appName)

  $assetCandidates = @(Get-ChildItem -LiteralPath $assetsDir -File | Where-Object { $_.Name -match '^useAppFontEffects-[A-Za-z0-9_-]+\.js$' })
  if ($assetCandidates.Count -ne 1) {
    Refuse ("expected exactly one assets/useAppFontEffects-*.js asset, found " + $assetCandidates.Count)
  }
  $assetPath = $assetCandidates[0].FullName
  $assetName = $assetCandidates[0].Name
  $assetBytes = [IO.File]::ReadAllBytes($assetPath)
  $assetSha = Get-BytesSha256 $assetBytes
  if ($assetSha -ne $expected) {
    Refuse ("asset sha256 " + $assetSha + " does not match the expected " + $expected + " (" + $assetPath + ")")
  }
  if ((Read-IndexText $assetBytes).IndexOf($MarkerToken, [StringComparison]::Ordinal) -ge 0) {
    Refuse ("the asset already carries the " + $MarkerToken + " marker but no matching install record: " + $assetPath)
  }
  Write-Line ("asset: " + $assetPath)
  Write-Line ("asset sha256: " + $assetSha)

  $adapterSource = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\integrations\openchamber"))
  $bootstrapSource = Join-Path $adapterSource "web"
  $planned = New-Object System.Collections.ArrayList
  foreach ($name in $BootstrapFileNames) {
    $source = Join-Path $bootstrapSource $name
    $target = Join-Path $Root $name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { Refuse "the adapter bootstrap file is missing in the repo: $source" }
    [void]$planned.Add([pscustomobject]@{ Path = $target; Source = $source; Added = $true })
  }
  $octmDir = Join-Path $Root "octm"
  foreach ($name in $ModuleFileNames) {
    $source = Join-Path $adapterSource $name
    $target = Join-Path $octmDir $name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { Refuse "the adapter module is missing in the repo: $source" }
    [void]$planned.Add([pscustomobject]@{ Path = $target; Source = $source; Added = $true })
  }

  $recordedPaths = @()
  if ($recordPaths) {
    foreach ($entry in @($recordPaths.Inside)) { $recordedPaths += [string]$entry.Path }
  }
  $foreign = @()
  foreach ($item in $planned) {
    if (Test-Path -LiteralPath $item.Path) {
      $full = [IO.Path]::GetFullPath($item.Path)
      if (-not ($recordedPaths -contains $full)) { $foreign += $item.Path }
    }
  }
  if ($foreign.Count -gt 0) {
    if (-not $Force) {
      Refuse ("target paths already hold files this install did not create: " + ($foreign -join ", ") + " (use -Force only for a recorded install)")
    }
    Write-Line ("force: overwriting " + $foreign.Count + " unrecorded target file(s)")
  }

  $patchedIndex = Get-PatchedIndex $indexText $entryTag

  if (-not $Apply) {
    Write-Line ("would back up: " + $indexPath + " and " + $assetPath + " under " + $backupRoot)
    Write-Line ("would patch: " + $assetPath)
    foreach ($item in $planned) { Write-Line ("would write: " + $item.Path) }
    Write-Line ("would write: " + $indexPath)
    if ($patchedIndex.Inserted) {
      Write-Line ("would add 3 adapter tags before " + $entrySrc)
    } else {
      Write-Line "index: adapter tags are already present, they would be left untouched"
    }
    Write-Line ("would write: " + $recordPath)
    Write-Line "dry run: nothing was written"
    Write-Line "result: ok"
    exit 0
  }

  $script:NodeExe = $null
  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCommand) { $script:NodeExe = $nodeCommand.Source }
  if (-not $script:NodeExe) { Refuse "node is required to stage and verify the patched asset, but it was not found" }

  $stageDir = Join-Path ([IO.Path]::GetTempPath()) ("octm-stage-" + [Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $stageDir -Force | Out-Null
  try {
    $stagedAsset = Join-Path $stageDir "patched.mjs"
    $applyScript = Join-Path $PSScriptRoot "apply-openchamber-patch.mjs"
    if (-not (Test-Path -LiteralPath $applyScript -PathType Leaf)) { Refuse "the patch script is missing: $applyScript" }
    $applyArguments = @($applyScript, "--asset", $assetPath, "--out", $stagedAsset)
    if ($expected -ne $pinned) { $applyArguments += @("--allow-hash", $expected) }
    $applyRun = Invoke-Node $applyArguments
    $applyReport = $null
    try { $applyReport = $applyRun.Output | ConvertFrom-Json } catch { $applyReport = $null }
    if ($applyRun.ExitCode -ne 0 -or -not $applyReport -or -not $applyReport.ok) {
      $reason = "the patch script failed"
      if ($applyReport -and $applyReport.error) { $reason = [string]$applyReport.error }
      elseif ($applyRun.Output) { $reason = $applyRun.Output }
      Refuse ("adapter patch failed: " + $reason)
    }
    Write-Line ("patch: " + @($applyReport.patches).Count + " patches applied to a staged copy (" + $applyReport.patchedLength + " bytes)")

    $checkRun = Invoke-Node @("--check", $stagedAsset)
    if ($checkRun.ExitCode -ne 0) { Refuse ("node --check failed on the staged asset: " + $checkRun.Output) }
    Write-Line "check: node --check passed on the staged asset"
    foreach ($name in $ModuleFileNames) {
      $modulePath = Join-Path $adapterSource $name
      $moduleRun = Invoke-Node @("--check", $modulePath)
      if ($moduleRun.ExitCode -ne 0) { Refuse ("node --check failed on " + $modulePath + ": " + $moduleRun.Output) }
    }
    Write-Line ("check: node --check passed on " + $ModuleFileNames.Count + " module(s)")

    $patchedAssetBytes = [IO.File]::ReadAllBytes($stagedAsset)
    $patchedAssetSha = Get-BytesSha256 $patchedAssetBytes
    $patchedIndexBytes = [Text.Encoding]::UTF8.GetBytes($patchedIndex.Text)
    $patchedIndexSha = Get-BytesSha256 $patchedIndexBytes

    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $backupDir = Join-Path $backupRoot $stamp
    $suffix = 1
    while (Test-Path -LiteralPath $backupDir) {
      $suffix = $suffix + 1
      $backupDir = Join-Path $backupRoot ($stamp + "-" + $suffix)
    }
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
    $backupIndex = Join-Path $backupDir "index.html"
    $backupAsset = Join-Path $backupDir $assetName
    [IO.File]::WriteAllBytes($backupIndex, $indexBytes)
    [IO.File]::WriteAllBytes($backupAsset, $assetBytes)
    $backupManifest = [ordered]@{
      createdAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffffffZ")
      version = $version
      pinned = $pinned
      index = $indexPath
      asset = $assetPath
      files = @(
        [ordered]@{
          path = $indexPath
          role = "index"
          sha256 = (Get-BytesSha256 $indexBytes)
          size = $indexBytes.Length
          patchedSha256 = $patchedIndexSha
          patchedSize = $patchedIndexBytes.Length
        },
        [ordered]@{
          path = $assetPath
          role = "asset"
          sha256 = $assetSha
          size = $assetBytes.Length
          patchedSha256 = $patchedAssetSha
          patchedSize = $patchedAssetBytes.Length
        }
      )
    }
    $backupManifestPath = Join-Path $backupDir "manifest.json"
    $backupManifestJson = ($backupManifest | ConvertTo-Json -Depth 8) + [Environment]::NewLine
    [IO.File]::WriteAllText($backupManifestPath, $backupManifestJson, (New-Object Text.UTF8Encoding($false)))
    Write-Line ("backup: " + $backupDir)

    $writes = New-Object System.Collections.ArrayList
    [void]$writes.Add([pscustomobject]@{ Path = $assetPath; Bytes = $patchedAssetBytes; Added = $false })
    foreach ($item in $planned) {
      [void]$writes.Add([pscustomobject]@{ Path = $item.Path; Bytes = [IO.File]::ReadAllBytes($item.Source); Added = $true })
    }
    [void]$writes.Add([pscustomobject]@{ Path = $indexPath; Bytes = $patchedIndexBytes; Added = $false })

    $written = New-Object System.Collections.ArrayList
    try {
      foreach ($write in $writes) {
        $directory = [IO.Path]::GetDirectoryName($write.Path)
        if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
          New-Item -ItemType Directory -Path $directory -Force | Out-Null
          Write-Line ("created dir: " + $directory)
        }
        $tempPath = $write.Path + ".octm-new"
        [IO.File]::WriteAllBytes($tempPath, $write.Bytes)
        Move-Item -LiteralPath $tempPath -Destination $write.Path -Force
        [void]$written.Add($write.Path)
        Write-Line ("wrote: " + $write.Path)
      }
    } catch {
      $failure = $_.Exception.Message
      foreach ($path in $written) {
        if (Test-Path -LiteralPath $path -PathType Leaf) { Remove-Item -LiteralPath $path -Force }
      }
      foreach ($write in $writes) {
        $tempPath = $write.Path + ".octm-new"
        if (Test-Path -LiteralPath $tempPath) { Remove-Item -LiteralPath $tempPath -Force }
      }
      [IO.File]::WriteAllBytes($indexPath, $indexBytes)
      [IO.File]::WriteAllBytes($assetPath, $assetBytes)
      Refuse ("the switch failed and was rolled back (" + $failure + ")")
    }
    if ($patchedIndex.Inserted) {
      Write-Line ("index: added 3 adapter tags before " + $entrySrc)
    } else {
      Write-Line "index: adapter tags were already present, left untouched"
    }

    $fileEntries = @()
    $addedPaths = @()
    foreach ($write in $writes) {
      $fileEntries += [ordered]@{ path = $write.Path; sha256 = (Get-BytesSha256 $write.Bytes) }
      if ($write.Added) { $addedPaths += $write.Path }
    }
    $recordObject = [ordered]@{
      version = $version
      installedAt = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffffffZ")
      assetSha256 = $patchedAssetSha
      backupDir = $backupDir
      files = $fileEntries
      added = $addedPaths
      indexHtmlSha256 = $patchedIndexSha
    }
    $recordJson = ($recordObject | ConvertTo-Json -Depth 8) + [Environment]::NewLine
    $recordTemp = $recordPath + ".octm-new"
    [IO.File]::WriteAllText($recordTemp, $recordJson, (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $recordTemp -Destination $recordPath -Force
    Write-Line ("wrote: " + $recordPath)

    foreach ($entry in $fileEntries) {
      if (-not (Test-Path -LiteralPath $entry.path -PathType Leaf)) {
        Refuse ("verification failed after the switch, missing: " + $entry.path)
      }
      $actual = Get-Sha256 $entry.path
      if ($actual -ne $entry.sha256) {
        Refuse ("verification failed after the switch, hash mismatch: " + $entry.path)
      }
    }
    Write-Line ("verified: " + $fileEntries.Count + " written file(s) match the install record")
    Write-Line ("installed: adapter " + $version + " into " + $Root)
    Write-Line "note: restart OpenChamber (or reload the UI with cache bypass) to load the adapter; a service-worker cache may still serve the old asset until it is cleared."
    Write-Line "result: ok"
    exit 0
  } finally {
    if (Test-Path -LiteralPath $stageDir) { Remove-Item -LiteralPath $stageDir -Recurse -Force }
  }
}

$targetRoot = [IO.Path]::GetFullPath($WebDist)
if ($Rollback -and $Apply) {
  Write-Line "refused: -Apply cannot be combined with -Rollback"
  Write-Line "result: refused"
  exit 1
}
if ($Rollback) {
  Invoke-Rollback $targetRoot
}
try {
  Invoke-Install $targetRoot
} catch {
  Refuse ("unexpected error: " + $_.Exception.Message)
}
