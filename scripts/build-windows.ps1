$ErrorActionPreference = 'Stop'

$project = Split-Path -Parent $PSScriptRoot
$release = Join-Path $project 'release'
$tempRoot = Join-Path $env:TEMP 'image-studio-build'
$installerOut = Join-Path $tempRoot 'installer'
$portableOut = Join-Path $tempRoot 'portable'

foreach ($path in @($release, $tempRoot)) {
  if (Test-Path -LiteralPath $path) {
    $resolved = (Resolve-Path -LiteralPath $path).Path
    if ($resolved -in @($release, $tempRoot)) { Remove-Item -LiteralPath $resolved -Recurse -Force }
  }
}

New-Item -ItemType Directory -Path $release -Force | Out-Null
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'

Push-Location $project
try {
  & npx electron-builder --win nsis "--config.directories.output=$installerOut" "--config.win.artifactName=ImageStudio-`${version}-Windows-`${arch}-Installer.`${ext}"
  if ($LASTEXITCODE -ne 0) { throw 'Windows installer build failed.' }

  & npx electron-builder --win portable "--config.directories.output=$portableOut" "--config.win.artifactName=ImageStudio-`${version}-Windows-`${arch}-Portable.`${ext}"
  if ($LASTEXITCODE -ne 0) { throw 'Windows portable build failed.' }

  Copy-Item -Path (Join-Path $installerOut '*.exe') -Destination $release
  Copy-Item -Path (Join-Path $installerOut '*.blockmap') -Destination $release -ErrorAction SilentlyContinue
  Copy-Item -Path (Join-Path $portableOut '*.exe') -Destination $release
} finally {
  Pop-Location
}

Write-Host "Windows packages created in $release"
