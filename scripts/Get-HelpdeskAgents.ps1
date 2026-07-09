<#
.SYNOPSIS
    Lists current Helpdesk.com agents, their roles, and the Teams they belong to,
    via the Helpdesk.com REST API v1.

.DESCRIPTION
    Read-only (GET-only) reporting script. It calls:
        GET /teams   -> builds a team-ID -> team-name lookup
        GET /agents  -> emits one row per agent (Email, Name, Roles, Status,
                        Teams resolved to names, raw TeamIDs)
    Results are printed as a table (sorted by Name) and optionally exported to CSV.

    AUTH NOTE (load-bearing - matches src/functions/helpdesk-client.ts):
    In this codebase the HELPDESK_PAT environment value is ALREADY the encoded
    Basic credential. It is sent verbatim after the literal "Basic " prefix.
    Do NOT base64-encode it again and do NOT build an "account_id:token" string -
    that would double-encode and break authentication.

.PARAMETER Pat
    The Helpdesk Personal Access Token (already the encoded Basic credential).
    Defaults to the HELPDESK_PAT environment variable.

.PARAMETER BaseUrl
    API base URL including /v1. Defaults to https://api.helpdesk.com/v1.

.PARAMETER OutCsv
    Optional path. If provided, results are exported to this CSV
    (UTF-8, no type information). The file is written BOM-free on both
    Windows PowerShell 5.1 and PowerShell 7+.

.EXAMPLE
    # Reads $env:HELPDESK_PAT, prints a table to the console
    .\Get-HelpdeskAgents.ps1

.EXAMPLE
    # Pass the PAT explicitly and export to CSV
    .\Get-HelpdeskAgents.ps1 -Pat $env:HELPDESK_PAT -OutCsv .\agents.csv

.NOTES
    Compatible with Windows PowerShell 5.1 and PowerShell 7+.
    Reads the HELPDESK_PAT environment variable by default.
    Idempotent / read-only: issues only HTTP GET requests.
#>

[CmdletBinding()]
param(
    [string]$Pat = "ZGMzNjk1MDYtNmU3NS00YTc5LTg2NDgtMTJhNTAwYmJlNDI4OnVzLXNvdXRoMTpsZTI1RWNydk1VdVRIYV9WWF9XSFJ0T3hUc0U=",
    [string]$BaseUrl = 'https://api.helpdesk.com/v1',
    [string]$OutCsv
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Windows PowerShell 5.1 defaults to SSL3/TLS1.0 for some hosts; force TLS 1.2.
# PowerShell 7+ negotiates TLS 1.2/1.3 already, so this is a harmless no-op there.
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
}
catch {
    # Some constrained environments don't expose Tls12; ignore and proceed.
}

if ([string]::IsNullOrWhiteSpace($Pat)) {
    throw "No PAT supplied. Pass -Pat or set the HELPDESK_PAT environment variable. (The value must be the encoded Basic credential, used verbatim after 'Basic '.)"
}

# Normalize base URL (strip a single trailing slash so path joins are clean).
$BaseUrl = $BaseUrl.TrimEnd('/')

# Auth + standard headers. The PAT is used RAW - see helpdesk-client.ts.
$Headers = @{
    Authorization = "Basic $Pat"
    Accept        = 'application/json'
    'User-Agent'  = 'cs-helpdesk-agent-report/1.0 (+https://corespecialty.com)'
}

# Whether this host can surface response headers from Invoke-RestMethod
# (-ResponseHeadersVariable exists on PowerShell 6.1+). Used to honor an
# RFC-5988 Link: rel="next" header and a 429 Retry-After.
$script:CanReadHeaders = $PSVersionTable.PSVersion.Major -ge 6 -and (Get-Command Invoke-RestMethod).Parameters.ContainsKey('ResponseHeadersVariable')

function Get-ErrorBody {
    <#
        Best-effort extraction of an HTTP error response body across PS 5.1 and 7+.
        PS 7 exposes $err.ErrorDetails.Message; PS 5.1 often only has the raw
        HttpWebResponse stream (GetResponseStream is a METHOD, so probe Methods,
        not Properties).
    #>
    param($ErrorRecord)

    # PS 7 (and sometimes 5.1) populate ErrorDetails with the response body.
    if ($ErrorRecord.ErrorDetails -and $ErrorRecord.ErrorDetails.Message) {
        return $ErrorRecord.ErrorDetails.Message
    }

    $resp = $null
    if ($ErrorRecord.Exception -and ($ErrorRecord.Exception.PSObject.Properties.Name -contains 'Response')) {
        $resp = $ErrorRecord.Exception.Response
    }
    if (-not $resp) { return $null }

    # PS 5.1: System.Net.HttpWebResponse with a readable stream. GetResponseStream
    # is a method, so detect it via the type or the Methods set, never Properties.
    try {
        if (($resp -is [System.Net.HttpWebResponse]) -or ($resp.PSObject.Methods.Name -contains 'GetResponseStream')) {
            $stream = $resp.GetResponseStream()
            if ($stream) {
                $reader = New-Object System.IO.StreamReader($stream)
                try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
            }
        }
    }
    catch {
        # fall through
    }

    # PS 7: HttpResponseMessage carries the body on .Content when ErrorDetails was empty.
    try {
        if ($resp.PSObject.Properties.Name -contains 'Content' -and $resp.Content) {
            $content = $resp.Content
            if ($content.PSObject.Methods.Name -contains 'ReadAsStringAsync') {
                return $content.ReadAsStringAsync().Result
            }
        }
    }
    catch {
        # fall through
    }

    return $null
}

function Get-ErrorStatusCode {
    param($ErrorRecord)

    # PS 7: HttpResponseMessage exposes StatusCode (enum); .value__ gives the int.
    if ($ErrorRecord.Exception) {
        $ex = $ErrorRecord.Exception
        if ($ex.PSObject.Properties.Name -contains 'Response' -and $ex.Response) {
            $resp = $ex.Response
            if ($resp.PSObject.Properties.Name -contains 'StatusCode' -and $null -ne $resp.StatusCode) {
                try { return [int]$resp.StatusCode } catch { }
            }
        }
    }
    return $null
}

function Get-RetryAfter {
    <#
        Best-effort read of a Retry-After header from an HTTP error response,
        across PS 5.1 (HttpWebResponse.Headers) and PS 7 (HttpResponseMessage).
    #>
    param($ErrorRecord)

    $resp = $null
    if ($ErrorRecord.Exception -and ($ErrorRecord.Exception.PSObject.Properties.Name -contains 'Response')) {
        $resp = $ErrorRecord.Exception.Response
    }
    if (-not $resp) { return $null }

    # PS 5.1: HttpWebResponse.Headers is a WebHeaderCollection (string indexer).
    try {
        if ($resp -is [System.Net.HttpWebResponse]) {
            $val = $resp.Headers['Retry-After']
            if ($val) { return [string]$val }
        }
    }
    catch { }

    # PS 7: HttpResponseMessage.Headers.RetryAfter (RetryConditionHeaderValue).
    try {
        if ($resp.PSObject.Properties.Name -contains 'Headers' -and $resp.Headers) {
            $ra = $resp.Headers.RetryAfter
            if ($ra) {
                if ($ra.Delta -and $ra.Delta.TotalSeconds) { return ('{0}' -f [int]$ra.Delta.TotalSeconds) }
                if ($ra.Date) { return [string]$ra.Date }
                return [string]$ra
            }
        }
    }
    catch { }

    return $null
}

function Get-NextLinkFromHeader {
    <#
        Parse an RFC-5988 Link header value for the rel="next" URL.
        Returns $null if none present.
    #>
    param($LinkHeader)

    if (-not $LinkHeader) { return $null }
    # -ResponseHeadersVariable yields a value that may be a string or string[].
    $linkText = (@($LinkHeader) -join ', ')
    $m = [regex]::Match($linkText, '<([^>]+)>\s*;\s*rel="?next"?')
    if ($m.Success) { return $m.Groups[1].Value }
    return $null
}

function Resolve-NextUrl {
    <#
        Resolve a possibly-relative next pointer against the request URL so
        Invoke-RestMethod (which requires an absolute URI) can follow it.
    #>
    param(
        [string]$Next,
        [string]$BaseRequestUrl
    )

    if ([string]::IsNullOrWhiteSpace($Next)) { return $null }
    if ($Next -match '^[a-z][a-z0-9+.-]*://') { return $Next }
    try {
        return [System.Uri]::new([System.Uri]$BaseRequestUrl, $Next).AbsoluteUri
    }
    catch {
        return $Next
    }
}

function Invoke-HelpdeskGet {
    <#
        GET a Helpdesk endpoint with robust error handling.

        PAGINATION ASSUMPTION:
        The documented v1 shape for /agents and /teams is a BARE JSON ARRAY with no
        pagination wrapper or cursor. This script assumes that and reads the whole
        list in a single call. As a defensive measure it ALSO inspects the response
        for common pagination signals - on PowerShell 6.1+ an RFC-5988
        'Link: <...>; rel="next"' header (captured via -ResponseHeadersVariable),
        or a body wrapper exposing data/items/results plus a next/nextLink cursor -
        and follows them if present, resolving relative cursors against the request
        URL. If none are present (the documented case), it stops after the first page.
        On Windows PowerShell 5.1 the Link header cannot be surfaced, so only the
        body-driven cursor path is available there.
    #>
    param(
        [Parameter(Mandatory)] [string]$Url
    )

    $aggregate = New-Object System.Collections.Generic.List[object]
    $nextUrl = $Url
    $guard = 0
    $maxPages = 1000  # safety cap against an unexpected pagination loop

    while ($nextUrl -and $guard -lt $maxPages) {
        $guard++
        # Remember the URL actually requested this iteration, so a relative next
        # pointer resolves against it (not against $nextUrl, which is nulled below).
        $currentRequestUrl = $nextUrl

        $respHeaders = $null
        try {
            # -Headers carries auth; Invoke-RestMethod deserializes JSON automatically.
            # No -ContentType: a GET sends no body, and Accept already requests JSON.
            $irmArgs = @{
                Method      = 'Get'
                Uri         = $nextUrl
                Headers     = $Headers
                ErrorAction = 'Stop'
            }
            if ($script:CanReadHeaders) {
                $irmArgs['ResponseHeadersVariable'] = 'respHeaders'
            }
            $response = Invoke-RestMethod @irmArgs
        }
        catch {
            $status = Get-ErrorStatusCode -ErrorRecord $_
            $body   = Get-ErrorBody -ErrorRecord $_

            $msg = "Helpdesk API GET failed for '$nextUrl'."
            if ($null -ne $status) { $msg += " HTTP status: $status." }

            switch ($status) {
                401 {
                    $msg += " Unauthorized - the PAT is missing, malformed, or expired. Confirm HELPDESK_PAT is the encoded Basic credential used verbatim (do NOT base64-encode it again)."
                }
                403 { $msg += " Forbidden - the token lacks permission for this resource." }
                429 {
                    $retryAfter = Get-RetryAfter -ErrorRecord $_
                    $msg += " Rate limited (Too Many Requests). Wait and retry."
                    if ($retryAfter) { $msg += " Retry-After: $retryAfter." }
                }
                default { }
            }

            if ($body) { $msg += [Environment]::NewLine + "Response body: " + $body }
            throw $msg
        }

        # --- Normalize this page into a list of records ---
        # Invoke-RestMethod / ConvertFrom-Json only yield [Object[]] (array),
        # [PSCustomObject] (object), or a scalar - so handle null, array, then
        # the wrapper-object case.
        $pageItems = $null
        $bodyNext = $null

        if ($null -eq $response) {
            $pageItems = @()
        }
        elseif ($response -is [System.Array]) {
            # Documented shape: a bare JSON array.
            $pageItems = $response
        }
        else {
            # Defensive: a wrapper object. Look for common item containers.
            $props = @($response.PSObject.Properties.Name)
            if ($props -contains 'data')        { $pageItems = $response.data }
            elseif ($props -contains 'items')   { $pageItems = $response.items }
            elseif ($props -contains 'results') { $pageItems = $response.results }
            else {
                # Unknown single object - treat as one record.
                $pageItems = @($response)
            }

            # Defensive: look for a body-embedded next pointer.
            if ($props -contains 'nextLink' -and $response.nextLink) {
                $bodyNext = [string]$response.nextLink
            }
            elseif ($props -contains 'next' -and $response.next) {
                # Could be a URL string, or a cursor object - only follow a URL string.
                if ($response.next -is [string]) { $bodyNext = $response.next }
            }
        }

        foreach ($it in @($pageItems)) {
            if ($null -ne $it) { [void]$aggregate.Add($it) }
        }

        # Determine the next page: a body cursor takes precedence, then (on capable
        # hosts) an RFC-5988 Link: rel="next" header. Relative cursors are resolved
        # against the current request URL.
        $nextUrl = $null
        if ($bodyNext) {
            $nextUrl = Resolve-NextUrl -Next $bodyNext -BaseRequestUrl $currentRequestUrl
        }
        elseif ($script:CanReadHeaders -and $respHeaders -and ($respHeaders.PSObject.Properties.Name -contains 'Link')) {
            $headerNext = Get-NextLinkFromHeader -LinkHeader $respHeaders.Link
            if ($headerNext) {
                $nextUrl = Resolve-NextUrl -Next $headerNext -BaseRequestUrl $currentRequestUrl
            }
        }

        # Documented case: no next pointer -> loop ends after the first page.
    }

    return $aggregate
}

# ---------------------------------------------------------------------------
# Fetch teams, build ID -> name lookup
# ---------------------------------------------------------------------------
Write-Verbose "Fetching teams from $BaseUrl/teams"
$teams = Invoke-HelpdeskGet -Url "$BaseUrl/teams"

$teamNameById = @{}
foreach ($team in @($teams)) {
    if ($null -eq $team) { continue }
    $tProps = @($team.PSObject.Properties.Name)
    $id = $null
    if ($tProps -contains 'ID' -and $team.ID) { $id = [string]$team.ID }
    elseif ($tProps -contains 'id' -and $team.id) { $id = [string]$team.id }
    if (-not $id) { continue }

    $tname = $null
    if ($tProps -contains 'name' -and $team.name) { $tname = [string]$team.name }
    if (-not $tname) { $tname = $id }  # fall back to the raw id if unnamed
    $teamNameById[$id] = $tname
}

Write-Verbose ("Loaded {0} teams." -f $teamNameById.Count)

# ---------------------------------------------------------------------------
# Fetch agents, project each into a flat report row
# ---------------------------------------------------------------------------
Write-Verbose "Fetching agents from $BaseUrl/agents"
$agents = Invoke-HelpdeskGet -Url "$BaseUrl/agents"

$rows = New-Object System.Collections.Generic.List[object]

foreach ($agent in @($agents)) {
    if ($null -eq $agent) { continue }
    $aProps = @($agent.PSObject.Properties.Name)

    $email = ''
    if ($aProps -contains 'email' -and $agent.email) { $email = [string]$agent.email }

    $name = ''
    if ($aProps -contains 'name' -and $agent.name) { $name = [string]$agent.name }

    $status = ''
    if ($aProps -contains 'status' -and $agent.status) { $status = [string]$agent.status }

    # roles: array of strings (owner|normal|viewer). Join for display.
    $rolesArr = @()
    if ($aProps -contains 'roles' -and $agent.roles) { $rolesArr = @($agent.roles) }
    $rolesStr = ($rolesArr | ForEach-Object { [string]$_ }) -join ';'

    # teamIDs: array of strings. Resolve to names; keep raw ids too.
    $teamIdsArr = @()
    if ($aProps -contains 'teamIDs' -and $agent.teamIDs) { $teamIdsArr = @($agent.teamIDs) }

    $teamNames = New-Object System.Collections.Generic.List[string]
    foreach ($tid in $teamIdsArr) {
        $tidStr = [string]$tid
        if ($teamNameById.ContainsKey($tidStr)) {
            [void]$teamNames.Add($teamNameById[$tidStr])
        }
        else {
            # Unknown team id - surface the raw id so nothing is silently dropped.
            [void]$teamNames.Add("$tidStr (unknown)")
        }
    }

    $rows.Add([PSCustomObject]@{
        Email   = $email
        Name    = $name
        Roles   = $rolesStr
        Status  = $status
        Teams   = ($teamNames -join ';')
        TeamIDs = (($teamIdsArr | ForEach-Object { [string]$_ }) -join ';')
    })
}

# Sort by Name for stable, readable output. Force array semantics with @(...)
# so .Count is valid for 0, 1, or N rows under Set-StrictMode on PS 5.1 and 7+.
$sorted = @($rows | Sort-Object -Property Name)
$count = $sorted.Count

# Console table.
$sorted | Format-Table -AutoSize

# Optional CSV export. Write BOM-free UTF-8 on both editions (PS 5.1's
# -Encoding UTF8 emits a BOM; PS 7's does not), for portable downstream parsing.
if ($OutCsv) {
    # @(...) keeps ConvertTo-Csv's output an array even for 0/1 rows; the ?? @()
    # is for the empty case where ConvertTo-Csv yields $null (WriteAllLines rejects null).
    $csvLines = @($sorted | ConvertTo-Csv -NoTypeInformation)
    if ($null -eq $csvLines) { $csvLines = @() }
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllLines($OutCsv, [string[]]$csvLines, $utf8NoBom)
    Write-Host ("Exported {0} agent(s) to {1}" -f $count, $OutCsv)
}

# Summary.
Write-Host ("Total agents: {0} | Teams known: {1}" -f $count, $teamNameById.Count)
