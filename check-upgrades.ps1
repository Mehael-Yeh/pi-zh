param([switch]$Capture)
$ErrorActionPreference = 'Stop'
# Baseline covers installed/configured package versions and shipped code,
# prompts and skill descriptions. It does not execute any third-party code.
$agent = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$settings = Get-Content (Join-Path $agent 'settings.json') -Raw | ConvertFrom-Json
$packages = @($settings.packages | ForEach-Object {
    if ($_ -isnot [string] -or $_ -notmatch '^npm:([^@]+|@[^/]+/[^@]+)(?:@.*)?$') {
        throw "Unsupported package specification: $_"
    }
    $name = $Matches[1]
    $root = Join-Path $agent "npm/node_modules/$name"
    $manifest = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
    $files = [ordered]@{}
    Get-ChildItem $root -Recurse -File | Where-Object {
        $relative = [IO.Path]::GetRelativePath($root, $_.FullName).Replace('\', '/')
        $relative -notmatch '(^|/)(node_modules|\.git|tests?|__tests__)/' -and
        ($_.Extension -in '.ts', '.js', '.mjs' -or $_.Name -eq 'package.json' -or
         ($_.Extension -eq '.md' -and $relative -match '(^|/)(prompts|skills)/'))
    } | Sort-Object FullName | ForEach-Object {
        $relative = [IO.Path]::GetRelativePath($root, $_.FullName).Replace('\', '/')
        $files[$relative] = (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    [ordered]@{ name = $name; version = $manifest.version; files = $files }
})
$baselinePath = Join-Path $PSScriptRoot 'upgrade-baseline.json'
if ($Capture) {
    if (Test-Path $baselinePath) { throw 'Baseline already exists. Review changes before explicitly replacing it.' }
    [ordered]@{ schema = 1; packages = $packages } | ConvertTo-Json -Depth 8 | Set-Content $baselinePath -Encoding utf8
    Write-Output "Captured $($packages.Count) packages with SHA-256 source baselines."
    exit 0
}
$baseline = Get-Content $baselinePath -Raw | ConvertFrom-Json -AsHashtable
$changes = 0
foreach ($current in $packages) {
    $old = @($baseline.packages | Where-Object { $_.name -eq $current.name })[0]
    if (!$old) { Write-Output "ADDED package: $($current.name)@$($current.version)"; $changes++; continue }
    if ($old.version -ne $current.version) {
        Write-Output "VERSION $($current.name): $($old.version) -> $($current.version)"; $changes++
    }
    foreach ($file in $current.files.Keys) {
        if (!$old.files.Contains($file)) { Write-Output "ADDED $($current.name)/$file"; $changes++ }
        elseif ($old.files[$file] -ne $current.files[$file]) { Write-Output "CHANGED $($current.name)/$file"; $changes++ }
    }
    foreach ($file in $old.files.Keys) {
        if (!$current.files.Contains($file)) { Write-Output "REMOVED $($current.name)/$file"; $changes++ }
    }
}
foreach ($old in $baseline.packages) {
    if (!($packages | Where-Object { $_.name -eq $old.name })) { Write-Output "REMOVED package: $($old.name)"; $changes++ }
}
if ($changes) { Write-Output "Review required: $changes version/source changes. Baseline was NOT modified."; exit 1 }
Write-Output 'PASS: package versions and source SHA-256 match the reviewed baseline.'
