# Fork convenience runner (Windows PowerShell).
#
#   .\run.ps1          build once, then serve the production build at
#                      http://localhost:4200 (no cache, SPA fallback)
#   .\run.ps1 -Dev     hot-reload dev server instead (http://localhost:4200)
#   .\run.ps1 -NoBuild serve the existing dist/ without rebuilding
#
# Angular's CLI needs Node >= 22.22.3; this points npm/ng at the pinned copy
# in .node/ so the machine's own Node is untouched. See CLAUDE.md.

param(
	[switch]$Dev,
	[switch]$NoBuild
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$node = Join-Path $root '.node\node-v22.23.2-win-x64'

if (-not (Test-Path (Join-Path $node 'node.exe'))) {
	Write-Error "Pinned Node not found at $node - see CLAUDE.md to restore it."
}
$env:Path = "$node;$env:Path"

Push-Location $root
try {
	if (-not (Test-Path (Join-Path $root 'node_modules'))) {
		Write-Host '==> npm install' -ForegroundColor Cyan
		npm install
	}
	if (-not (Test-Path (Join-Path $root 'src\env\env.ts'))) {
		Copy-Item (Join-Path $root 'src\env\env.prod.ts') (Join-Path $root 'src\env\env.ts')
	}

	if ($Dev) {
		Write-Host '==> npm start (hot-reload dev server)' -ForegroundColor Cyan
		npm start
		return
	}

	if (-not $NoBuild) {
		Write-Host '==> npm run build' -ForegroundColor Cyan
		npm run build
	}
	Write-Host '==> serving dist/ at http://localhost:4200  (Ctrl+C to stop)' -ForegroundColor Green
	npm run serve:dist
}
finally {
	Pop-Location
}
