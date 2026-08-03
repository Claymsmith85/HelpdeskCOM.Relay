#Lets not screw up my repo moving to main.
param([int]$ChunkChars = 30000000, [string]$OutDir = "C:\Users\Clayton.Smith\Downloads\HDCBackup")

if (-not (git rev-parse --is-inside-work-tree 2>$null)) { throw "Not inside a git repo." }
if (-not (git rev-parse HEAD 2>$null))                  { throw "Repo has no commits." }
if (git status --porcelain) { Write-Warning "Uncommitted/untracked changes will NOT be exported (only HEAD). Commit first if you want them." }

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Get-ChildItem -Path $OutDir -Filter "chunk-*.txt" | Remove-Item -Force  # clear stale chunks
$tgz = Join-Path $OutDir "repo.tgz"
git archive --format=tar.gz -o $tgz HEAD; if ($LASTEXITCODE) { throw "git archive failed." }

$bytes = [IO.File]::ReadAllBytes($tgz)
$hash  = (Get-FileHash -Algorithm SHA256 $tgz).Hash.ToLower()
$b64   = [Convert]::ToBase64String($bytes)
$total = $b64.Length
$n     = [Math]::Ceiling($total / $ChunkChars)

for ($k = 0; $k -lt $n; $k++) {
  $start = $k * $ChunkChars
  $len   = [Math]::Min($ChunkChars, $total - $start)
  $idx   = $k + 1
  $head  = "# M365-EXPORT v1`n# chunk $idx/$n`n# sha256 $hash`n# chars $total`n"
  $file  = Join-Path $OutDir ("chunk-{0:D2}.txt" -f $idx)
  [IO.File]::WriteAllText($file, $head + $b64.Substring($start, $len), [Text.Encoding]::ASCII)
}
"Wrote $n chunk(s) to $OutDir"
"sha256 $hash   (must match the importer's OK line on the Linux box)"
Start-Process $OutDir