<#
.SYNOPSIS
    Lists webhooks registered on the Helpdesk.com account.
.EXAMPLE
    .\Get-HelpdeskWebhooks.ps1 -Pat "xxxx"          # active only (default)
    .\Get-HelpdeskWebhooks.ps1 -Pat "xxxx" -All     # include inactive
    .\scripts\Get-HelpdeskWebhooks.ps1 -Pat "ZGMzNjk1MDYtNmU3NS00YTc5LTg2NDgtMTJhNTAwYmJlNDI4OnVzLXNvdXRoMToxTDRVdFByYVprWDA0SHgtSGJSbG1Wb01hVk0=" -Raw     # full JSON, no filtering/projection
#>
param(
    # Pre-encoded Basic token — the same value as the relay's HELPDESK_PAT setting.
    [string]$Pat = "",
    [string]$BaseUrl = "https://api.helpdesk.com/v1",
    [switch]$All,
    [switch]$Raw = $true
)

if (-not $Pat) { throw "Provide -Pat or set `$env:HELPDESK_PAT" }

$headers = @{ Authorization = "Basic $Pat" }

try {
    $resp = Invoke-RestMethod -Uri "$BaseUrl/webhooks" -Headers $headers -Method Get
} catch {
    $status = $_.Exception.Response.StatusCode.value__
    throw "GET /webhooks failed (HTTP $status): $($_.ErrorDetails.Message)"
}

# Response may be a bare array or wrapped; normalize to an array of webhook objects.
$hooks = if ($resp -is [array]) { $resp } elseif ($resp.webhooks) { $resp.webhooks } else { @($resp) }

if ($Raw) {
    $hooks | ConvertTo-Json -Depth 10
    return
}

if (-not $All) {
    # Field name differs across API versions; treat "no active field" as active.
    $hooks = $hooks | Where-Object {
        ($null -eq $_.isActive -and $null -eq $_.active) -or $_.isActive -eq $true -or $_.active -eq $true
    }
}

if (-not $hooks) { Write-Host "No webhooks found."; return }

$hooks | ForEach-Object {
    [pscustomobject]@{
        Id     = $_.id
        Action = if ($_.action) { $_.action } else { ($_.events -join ", ") }
        Url    = $_.url
        Active = if ($null -ne $_.isActive) { $_.isActive } elseif ($null -ne $_.active) { $_.active } else { "(n/a)" }
    }
} | Format-Table -AutoSize