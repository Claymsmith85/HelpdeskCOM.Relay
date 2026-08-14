<#
.SYNOPSIS
    Deletes Helpdesk.com tickets that were created through the API (source.type = "api")
    before a cutoff instant - by default 2026-08-14T20:00:00Z.

.DESCRIPTION
    DESTRUCTIVE. Built for clearing a large backlog of relay-generated test tickets.

    It runs in three phases, so nothing is deleted before the full scope is known:

      1. SCAN    - pages GET /tickets ascending by createdAt and collects candidates.
      2. DELETE  - DELETE /tickets/{ticketID} for each candidate, with progress + audit.
      3. VERIFY  - re-scans; anything a cursor drift skipped is deleted on the next pass,
                   repeating until a scan finds nothing new (or -MaxPasses is hit).

    SELECTION RULE (both must hold, or the ticket is left alone):
        source.type  -eq  'api'   (case-insensitive; -SourceType overrides)
        createdAt    -lt  the -Before instant, compared in UTC

    Tickets whose source or createdAt cannot be determined are NEVER deleted; they are
    counted as "indeterminate" and listed in the summary. Every relay-created ticket is an
    API ticket (process-mail.ts POSTs /tickets), but so is anything else that used the API
    token - always read a -WhatIf run before committing.

    PAGINATION (HelpDesk API v1, cursor-based - this is what makes a big backlog work):
    the list endpoint returns a BARE JSON ARRAY and takes `pageSize` (default 20, max 100),
    `sortBy` (createdAt|updatedAt|lastMessageAt) and `order` (asc|desc). The next page is
    requested with the composite cursor `next.value` (the sort timestamp of the last row on
    the current page) + `next.ID` (that row's ticket ID). This script sorts ASCENDING by
    createdAt and stops paging at the first ticket created at/after the cutoff - so the scan
    costs pages proportional to the purge window, not to the tenant's whole ticket history.
    Every page is also deduped by ticket ID, and a cursor that fails to advance aborts the
    scan instead of looping (see -CursorStyle if the parameter encoding is ever rejected).

    SAFETY:
      * -WhatIf reports the full candidate list and deletes nothing.
      * Without -Force you get ONE bulk confirmation showing the exact count (a per-ticket
        prompt is useless at this volume); -Confirm still forces per-ticket prompts.
      * -MaxDeletions caps the blast radius (default 0 = no cap).
      * Calls are paced at -ThrottleMs (default 200 ms ~ the relay's 5 rps Helpdesk limiter)
        and 429/5xx are retried with backoff, honoring Retry-After.

    AUTH NOTE (load-bearing - matches src/functions/helpdesk-client.ts):
    HELPDESK_PAT is ALREADY the encoded Basic credential. It is sent verbatim after the
    literal "Basic " prefix. Do NOT base64-encode it again and do NOT build an
    "account_id:token" string - that double-encodes and breaks authentication.

.PARAMETER Pat
    Helpdesk Personal Access Token (the encoded Basic credential). Defaults to $env:HELPDESK_PAT.

.PARAMETER BaseUrl
    API base URL including /v1. Defaults to https://api.helpdesk.com/v1.

.PARAMETER Before
    Exclusive cutoff. Tickets created strictly BEFORE this instant are candidates.
    Parsed as UTC when no offset is given. Default: 2026-08-14T20:00:00Z.

.PARAMETER After
    Optional inclusive lower bound (client-side). Tickets created before it are ignored,
    e.g. -After '2026-06-01T00:00:00Z' to spare anything older than the relay pilot.

.PARAMETER SourceType
    Ticket source type to match. Default 'api'.

.PARAMETER PageSize
    Rows per list page, 1-100 (API max is 100). Default 100.

.PARAMETER CursorStyle
    Encoding for the paging cursor: 'dot' -> next.value=...&next.ID=... (documented, default),
    'bracket' -> next[value]=...&next[ID]=... Only change this if the API rejects the cursor.

.PARAMETER MaxDeletions
    Hard cap on deletions for the whole run. Default 0 (no cap).

.PARAMETER MaxPasses
    Maximum scan/delete passes before stopping. Default 10.

.PARAMETER ThrottleMs
    Delay between API calls. Default 200 ms (~5 rps, matching the relay's limiter).

.PARAMETER OutCsv
    Path for a BOM-free UTF-8 CSV audit log of every candidate and its outcome. Written
    incrementally after each pass, so an interrupted run still leaves a usable record.

.PARAMETER Force
    Skip the bulk confirmation prompt.

.EXAMPLE
    # Dry run: page the whole window, print every ticket that would be deleted
    .\Remove-HelpdeskApiTickets.ps1 -WhatIf

.EXAMPLE
    # Commit, with an audit trail
    .\Remove-HelpdeskApiTickets.ps1 -Force -OutCsv .\deleted-tickets.csv

.EXAMPLE
    # Only the test window, capped while you sanity-check the first batch
    .\Remove-HelpdeskApiTickets.ps1 -After '2026-08-01T00:00:00Z' -MaxDeletions 50

.NOTES
    Compatible with Windows PowerShell 5.1 and PowerShell 7+.
    DELETE moves a ticket to the API's "trash" silo (read-only, purged 30 days after its
    last update) rather than erasing it instantly - so a mistaken run has a recovery window,
    but do not rely on it. This script was authored without network access to the API; the
    endpoints/parameters follow the published v1 contract. If the tenant rejects the verb or
    the cursor encoding, the script aborts with the response body instead of guessing at a
    fallback (e.g. PATCHing a status), because a wrong guess silently mutates live tickets.
#>

[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [string]$Pat = $env:HELPDESK_PAT,
    [string]$BaseUrl = 'https://api.helpdesk.com/v1',
    [string]$Before = '2026-08-14T20:00:00Z',
    [string]$After,
    [string]$SourceType = 'api',
    [ValidateRange(1, 100)] [int]$PageSize = 100,
    [ValidateSet('dot', 'bracket')] [string]$CursorStyle = 'dot',
    [ValidateRange(0, [int]::MaxValue)] [int]$MaxDeletions = 0,
    [ValidateRange(1, 100)] [int]$MaxPasses = 10,
    [ValidateRange(0, 60000)] [int]$ThrottleMs = 200,
    [string]$OutCsv,
    [switch]$Force
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

$BaseUrl = $BaseUrl.TrimEnd('/')

$Headers = @{
    Authorization = "Basic $Pat"
    Accept        = 'application/json'
    'User-Agent'  = 'cs-helpdesk-ticket-purge/1.0 (+https://corespecialty.com)'
}

$script:CanReadHeaders = $PSVersionTable.PSVersion.Major -ge 6 -and (Get-Command Invoke-RestMethod).Parameters.ContainsKey('ResponseHeadersVariable')

# ---------------------------------------------------------------------------
# Time helpers
# ---------------------------------------------------------------------------

function ConvertTo-UtcOffset {
    <#
        Normalize a JSON timestamp to UTC. Invoke-RestMethod may hand back either a raw
        string or an already-deserialized [datetime] (whose Kind is Local or Unspecified
        depending on host/version) - so all cases are handled explicitly, and an
        unparseable value returns $null rather than a wrong instant.
    #>
    param($Value)

    if ($null -eq $Value) { return $null }
    if ($Value -is [System.DateTimeOffset]) { return $Value.ToUniversalTime() }

    if ($Value -is [datetime]) {
        switch ($Value.Kind) {
            'Utc' { return [System.DateTimeOffset]::new($Value) }
            'Local' { return ([System.DateTimeOffset]::new($Value)).ToUniversalTime() }
            default { return [System.DateTimeOffset]::new([datetime]::SpecifyKind($Value, [System.DateTimeKind]::Utc)) }
        }
    }

    $text = [string]$Value
    if ([string]::IsNullOrWhiteSpace($text)) { return $null }
    $parsed = [System.DateTimeOffset]::MinValue
    $st = [System.Globalization.DateTimeStyles]::AssumeUniversal -bor [System.Globalization.DateTimeStyles]::AdjustToUniversal
    if ([System.DateTimeOffset]::TryParse($text, [System.Globalization.CultureInfo]::InvariantCulture, $st, [ref]$parsed)) {
        return $parsed.ToUniversalTime()
    }
    return $null
}

function ConvertTo-BoundUtc {
    param([string]$Text, [string]$ParamName)

    $parsed = [System.DateTimeOffset]::MinValue
    $st = [System.Globalization.DateTimeStyles]::AssumeUniversal -bor [System.Globalization.DateTimeStyles]::AdjustToUniversal
    if (-not [System.DateTimeOffset]::TryParse($Text, [System.Globalization.CultureInfo]::InvariantCulture, $st, [ref]$parsed)) {
        throw "Could not parse -$ParamName value '$Text'. Use an ISO-8601 instant, e.g. '2026-08-14T20:00:00Z'."
    }
    return $parsed.ToUniversalTime()
}

function Format-Instant {
    param([System.DateTimeOffset]$Value)
    return $Value.UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ssZ', [System.Globalization.CultureInfo]::InvariantCulture)
}

$cutoffUtc = ConvertTo-BoundUtc -Text $Before -ParamName 'Before'
$lowerUtc = $null
if (-not [string]::IsNullOrWhiteSpace($After)) {
    $lowerUtc = ConvertTo-BoundUtc -Text $After -ParamName 'After'
    if ($lowerUtc -ge $cutoffUtc) { throw "-After ($(Format-Instant $lowerUtc)) must be earlier than -Before ($(Format-Instant $cutoffUtc))." }
}

# ---------------------------------------------------------------------------
# HTTP plumbing
# ---------------------------------------------------------------------------

function Get-Prop {
    <#
        Set-StrictMode-safe property read off a PSCustomObject. Returns $null when the
        property is absent instead of throwing.
    #>
    param($InputObject, [string]$Name)

    if ($null -eq $InputObject) { return $null }
    try {
        if (@($InputObject.PSObject.Properties.Name) -contains $Name) { return $InputObject.$Name }
    }
    catch { }
    return $null
}

function Get-ErrorBody {
    <#
        Best-effort extraction of an HTTP error response body across PS 5.1 and 7+.
        PS 7 exposes $err.ErrorDetails.Message; PS 5.1 often only has the raw
        HttpWebResponse stream (GetResponseStream is a METHOD, so probe Methods).
    #>
    param($ErrorRecord)

    if ($ErrorRecord.ErrorDetails -and $ErrorRecord.ErrorDetails.Message) {
        return $ErrorRecord.ErrorDetails.Message
    }

    $resp = $null
    if ($ErrorRecord.Exception -and ($ErrorRecord.Exception.PSObject.Properties.Name -contains 'Response')) {
        $resp = $ErrorRecord.Exception.Response
    }
    if (-not $resp) { return $null }

    try {
        if (($resp -is [System.Net.HttpWebResponse]) -or ($resp.PSObject.Methods.Name -contains 'GetResponseStream')) {
            $stream = $resp.GetResponseStream()
            if ($stream) {
                $reader = New-Object System.IO.StreamReader($stream)
                try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
            }
        }
    }
    catch { }

    try {
        if ($resp.PSObject.Properties.Name -contains 'Content' -and $resp.Content) {
            $content = $resp.Content
            if ($content.PSObject.Methods.Name -contains 'ReadAsStringAsync') {
                return $content.ReadAsStringAsync().Result
            }
        }
    }
    catch { }

    return $null
}

function Get-ErrorStatusCode {
    param($ErrorRecord)

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

function Get-RetryAfterSeconds {
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
            $secs = 0
            if ($val -and [int]::TryParse([string]$val, [ref]$secs)) { return $secs }
        }
    }
    catch { }

    # PS 7: HttpResponseMessage.Headers.RetryAfter (RetryConditionHeaderValue).
    try {
        if ($resp.PSObject.Properties.Name -contains 'Headers' -and $resp.Headers) {
            $ra = $resp.Headers.RetryAfter
            if ($ra -and $ra.Delta -and $ra.Delta.TotalSeconds) { return [int]$ra.Delta.TotalSeconds }
        }
    }
    catch { }

    return $null
}

function Invoke-HelpdeskApi {
    <#
        One Helpdesk API call, paced and retried.

        Retries 408/429/5xx and transport errors with exponential backoff (honoring
        Retry-After); a definitive 4xx throws immediately, so a rate limit never looks like
        a failure and a rejected DELETE is never silently re-issued. The thrown exception
        carries .Data['StatusCode'] so callers can special-case (e.g. 404 = already gone).
    #>
    param(
        [Parameter(Mandatory)] [ValidateSet('Get', 'Delete')] [string]$Method,
        [Parameter(Mandatory)] [string]$Url,
        [int]$MaxRetries = 5,
        [switch]$Raw,
        [switch]$PagingCall   # only these get the cursor-encoding hint on a 400/422
    )

    $attempt = 0
    while ($true) {
        $attempt++
        if ($ThrottleMs -gt 0) { Start-Sleep -Milliseconds $ThrottleMs }

        $respHeaders = $null
        try {
            $irmArgs = @{
                Method      = $Method
                Uri         = $Url
                Headers     = $Headers
                ErrorAction = 'Stop'
            }
            if ($script:CanReadHeaders) { $irmArgs['ResponseHeadersVariable'] = 'respHeaders' }
            $body = Invoke-RestMethod @irmArgs
            if ($Raw) { return @{ Body = $body; Headers = $respHeaders } }
            return $body
        }
        catch {
            $status = Get-ErrorStatusCode -ErrorRecord $_
            $transient = ($null -eq $status) -or ($status -eq 408) -or ($status -eq 429) -or ($status -ge 500)

            if ($transient -and $attempt -le $MaxRetries) {
                $waitSec = Get-RetryAfterSeconds -ErrorRecord $_
                if (-not $waitSec -or $waitSec -lt 1) { $waitSec = [int][Math]::Min(60, [Math]::Pow(2, $attempt)) }
                $what = if ($null -eq $status) { 'transport error' } else { "HTTP $status" }
                Write-Warning ("{0} {1} -> {2}; retry {3}/{4} in {5}s" -f $Method, $Url, $what, $attempt, $MaxRetries, $waitSec)
                Start-Sleep -Seconds $waitSec
                continue
            }

            $respBody = Get-ErrorBody -ErrorRecord $_
            $altCursor = if ($CursorStyle -eq 'dot') { 'bracket' } else { 'dot' }
            $cursorHint = if ($PagingCall) { " The API may not accept the '$CursorStyle' cursor encoding; try -CursorStyle $altCursor." } else { '' }
            $msg = "Helpdesk API $Method failed for '$Url'."
            if ($null -ne $status) { $msg += " HTTP status: $status." }
            switch ($status) {
                400 { $msg += " Bad Request.$cursorHint" }
                401 { $msg += " Unauthorized - the PAT is missing, malformed, or expired. Confirm HELPDESK_PAT is the encoded Basic credential used verbatim (do NOT base64-encode it again)." }
                403 { $msg += " Forbidden - the token lacks permission for this resource." }
                405 { $msg += " Method Not Allowed - this tenant's API does not expose $Method on that route. Aborting rather than guessing at an alternative." }
                422 { $msg += " Unprocessable.$cursorHint" }
                501 { $msg += " Not Implemented - this tenant's API does not expose $Method on that route. Aborting rather than guessing at an alternative." }
                default { }
            }
            if ($respBody) { $msg += [Environment]::NewLine + "Response body: " + $respBody }

            $err = New-Object System.Exception($msg, $_.Exception)
            $err.Data['StatusCode'] = $status
            throw $err
        }
    }
}

# ---------------------------------------------------------------------------
# Paging
# ---------------------------------------------------------------------------

function Get-NextLinkFromHeader {
    param($LinkHeader)

    if (-not $LinkHeader) { return $null }
    $linkText = (@($LinkHeader) -join ', ')
    $m = [regex]::Match($linkText, '<([^>]+)>\s*;\s*rel="?next"?')
    if ($m.Success) { return $m.Groups[1].Value }
    return $null
}

function Resolve-Url {
    param([string]$Candidate, [string]$BaseRequestUrl)

    if ([string]::IsNullOrWhiteSpace($Candidate)) { return $null }
    if ($Candidate -match '^[a-z][a-z0-9+.-]*://') { return $Candidate }
    try { return [System.Uri]::new([System.Uri]$BaseRequestUrl, $Candidate).AbsoluteUri }
    catch { return $Candidate }
}

function New-ListUrl {
    <#
        Build a GET /tickets URL. Ascending by createdAt so the purge window is scanned
        oldest-first and the walk can stop at the cutoff; the cursor is the composite
        (sort value, ID) of the last row of the previous page.
    #>
    param(
        [System.DateTimeOffset]$CursorValue,
        [string]$CursorId
    )

    $parts = New-Object System.Collections.Generic.List[string]
    [void]$parts.Add("pageSize=$PageSize")
    [void]$parts.Add('sortBy=createdAt')
    [void]$parts.Add('order=asc')

    if ($CursorId) {
        # Round-trip format ('o') keeps sub-second precision so the cursor lands exactly on
        # the row it names rather than a neighbour sharing the same second.
        $value = $CursorValue.UtcDateTime.ToString('o', [System.Globalization.CultureInfo]::InvariantCulture)
        if ($CursorStyle -eq 'bracket') {
            [void]$parts.Add('next%5Bvalue%5D=' + [System.Uri]::EscapeDataString($value))
            [void]$parts.Add('next%5BID%5D=' + [System.Uri]::EscapeDataString($CursorId))
        }
        else {
            [void]$parts.Add('next.value=' + [System.Uri]::EscapeDataString($value))
            [void]$parts.Add('next.ID=' + [System.Uri]::EscapeDataString($CursorId))
        }
    }

    return "$BaseUrl/tickets?" + ($parts -join '&')
}

function Get-PageItems {
    <#
        Normalize one /tickets response into records + an optional server-supplied next URL.
        The documented v1 shape is a BARE JSON ARRAY; the wrapper/Link handling is defensive
        so an undocumented paging change can't silently truncate the sweep.
    #>
    param($Response, $ResponseHeaders, [string]$RequestUrl)

    $items = @()
    $next = $null

    if ($null -eq $Response) {
        $items = @()
    }
    elseif ($Response -is [System.Array]) {
        $items = $Response
    }
    else {
        $props = @($Response.PSObject.Properties.Name)
        if ($props -contains 'data') { $items = $Response.data }
        elseif ($props -contains 'items') { $items = $Response.items }
        elseif ($props -contains 'results') { $items = $Response.results }
        elseif ($props -contains 'tickets') { $items = $Response.tickets }
        else { $items = @($Response) }

        if ($props -contains 'nextLink' -and $Response.nextLink) { $next = [string]$Response.nextLink }
        elseif ($props -contains 'next' -and $Response.next -is [string]) { $next = [string]$Response.next }
    }

    if (-not $next -and $script:CanReadHeaders -and $ResponseHeaders -and (@($ResponseHeaders.PSObject.Properties.Name) -contains 'Link')) {
        $next = Get-NextLinkFromHeader -LinkHeader $ResponseHeaders.Link
    }
    if ($next) { $next = Resolve-Url -Candidate $next -BaseRequestUrl $RequestUrl }

    return @{ Items = @($items); NextUrl = $next }
}

function Get-TicketId {
    param($Ticket)

    $id = Get-Prop $Ticket 'ID'
    if (-not $id) { $id = Get-Prop $Ticket 'id' }
    if ($id) { return [string]$id }
    return $null
}

function Resolve-TicketFacts {
    <#
        Project one list row into the facts the rule needs, fetching GET /tickets/{id} only
        when the row omitted source or createdAt. Either field staying unknown makes the
        ticket indeterminate -> never deleted.
    #>
    param($Ticket)

    $id = Get-TicketId $Ticket
    $sourceType = Get-Prop (Get-Prop $Ticket 'source') 'type'
    $createdUtc = ConvertTo-UtcOffset (Get-Prop $Ticket 'createdAt')
    $shortId = Get-Prop $Ticket 'shortID'
    $subject = Get-Prop $Ticket 'subject'
    $requester = Get-Prop (Get-Prop $Ticket 'requester') 'email'

    if ($id -and ((-not $sourceType) -or ($null -eq $createdUtc))) {
        try {
            $detail = Invoke-HelpdeskApi -Method Get -Url "$BaseUrl/tickets/$id"
            if (-not $sourceType) { $sourceType = Get-Prop (Get-Prop $detail 'source') 'type' }
            if ($null -eq $createdUtc) { $createdUtc = ConvertTo-UtcOffset (Get-Prop $detail 'createdAt') }
            if (-not $shortId) { $shortId = Get-Prop $detail 'shortID' }
            if (-not $subject) { $subject = Get-Prop $detail 'subject' }
            if (-not $requester) { $requester = Get-Prop (Get-Prop $detail 'requester') 'email' }
        }
        catch {
            Write-Warning ("Could not read ticket {0} detail; treating as indeterminate. {1}" -f $id, $_.Exception.Message)
        }
    }

    return [PSCustomObject]@{
        Id           = $id
        ShortId      = if ($shortId) { [string]$shortId } else { '' }
        Subject      = if ($subject) { [string]$subject } else { '' }
        Requester    = if ($requester) { [string]$requester } else { '' }
        SourceType   = if ($sourceType) { [string]$sourceType } else { '' }
        CreatedAtUtc = $createdUtc
    }
}

function Find-CandidateTickets {
    <#
        Phase 1/3: page the createdAt-ascending list and return the tickets matching the
        rule. Read-only. Stops at the first ticket created at/after the cutoff, so the scan
        is bounded by the purge window rather than the tenant's whole ticket history.

        $ExcludeIds holds tickets already deleted this run: a tenant whose list includes the
        trash silo would otherwise re-offer them forever.
    #>
    param(
        [System.Collections.Generic.HashSet[string]]$ExcludeIds,
        [System.Collections.Generic.List[object]]$Indeterminate
    )

    $candidates = New-Object System.Collections.Generic.List[object]
    $seenIds = New-Object System.Collections.Generic.HashSet[string]
    $url = New-ListUrl
    $page = 0
    $rowsSeen = 0
    $lastCursorId = $null
    $reachedCutoff = $false

    while ($url) {
        $page++
        $raw = Invoke-HelpdeskApi -Method Get -Url $url -Raw -PagingCall
        $parsed = Get-PageItems -Response $raw.Body -ResponseHeaders $raw.Headers -RequestUrl $url
        $items = @($parsed.Items)
        if ($items.Count -eq 0) { break }
        $rowsSeen += $items.Count

        $lastFacts = $null
        $newOnPage = 0

        foreach ($t in $items) {
            $facts = Resolve-TicketFacts -Ticket $t
            if (-not $facts.Id) { continue }
            if ($null -ne $facts.CreatedAtUtc) { $lastFacts = $facts }

            # Dedupe: a cursor landing a row early (or a sub-second precision wobble) must
            # not queue the same ticket twice.
            if (-not $seenIds.Add($facts.Id)) { continue }
            $newOnPage++

            if (-not $facts.SourceType -or ($null -eq $facts.CreatedAtUtc)) {
                [void]$Indeterminate.Add($facts)
                continue
            }

            # Ascending scan: the first at/after the cutoff ends the useful window.
            if ($facts.CreatedAtUtc -ge $cutoffUtc) { $reachedCutoff = $true; break }
            if ($lowerUtc -and $facts.CreatedAtUtc -lt $lowerUtc) { continue }
            if ($ExcludeIds -and $ExcludeIds.Contains($facts.Id)) { continue }

            if ([string]::Equals($facts.SourceType, $SourceType, [System.StringComparison]::OrdinalIgnoreCase)) {
                [void]$candidates.Add($facts)
            }
        }

        Write-Progress -Activity 'Scanning tickets' -Status ("page {0} | {1} row(s) read | {2} candidate(s)" -f $page, $rowsSeen, $candidates.Count) -PercentComplete -1

        if ($reachedCutoff) { break }

        # A server-supplied next pointer wins; otherwise build the documented composite
        # cursor from the last row of this page.
        if ($parsed.NextUrl) {
            $url = $parsed.NextUrl
            continue
        }
        if ($items.Count -lt $PageSize) { break }   # short page = last page
        if (-not $lastFacts) {
            Write-Warning "A full page carried no usable createdAt/ID, so no cursor can be built; stopping the scan."
            break
        }
        if ($lastFacts.Id -eq $lastCursorId -or $newOnPage -eq 0) {
            Write-Warning ("Paging cursor did not advance past ticket {0} - the API may not accept the '{1}' cursor encoding. Stopping the scan; try -CursorStyle {2}." -f $lastFacts.Id, $CursorStyle, $(if ($CursorStyle -eq 'dot') { 'bracket' } else { 'dot' }))
            break
        }
        $lastCursorId = $lastFacts.Id
        $url = New-ListUrl -CursorValue $lastFacts.CreatedAtUtc -CursorId $lastFacts.Id
    }

    Write-Progress -Activity 'Scanning tickets' -Completed
    Write-Host ("Scanned {0} row(s) across {1} page(s); {2} match(es) the rule." -f $rowsSeen, $page, $candidates.Count)
    if (-not $reachedCutoff -and $rowsSeen -gt 0) {
        Write-Verbose "Scan ended without reaching a post-cutoff ticket (the window may simply be the whole ticket list)."
    }
    return $candidates
}

function Write-TicketLines {
    <#
        Print a capped sample of ticket rows.

        Deliberately hand-formatted instead of Format-Table: the table formatters need a
        host width, and throw "Argument types do not match" when this many columns are
        rendered into a redirected (non-console) stdout - which is exactly how an operator
        runs a big purge (`... | Tee-Object purge.log`). The CSV is the complete record.
    #>
    param(
        $Rows,
        [int]$Max = 25
    )

    $all = @($Rows)
    $shown = 0
    foreach ($r in $all) {
        if ($shown -ge $Max) { break }
        $shown++
        $subject = [string]$r.Subject
        if ($subject.Length -gt 60) { $subject = $subject.Substring(0, 57) + '...' }
        $created = if ($null -ne $r.CreatedAtUtc) { Format-Instant $r.CreatedAtUtc } else { '(unknown)' }
        Write-Host ("  {0,-38} {1,-10} {2,-21} {3}" -f $r.Id, $r.ShortId, $created, $subject)
    }
    if ($all.Count -gt $shown) {
        Write-Host ("  ... and {0} more" -f ($all.Count - $shown))
    }
}

function Write-AuditCsv {
    param([System.Collections.Generic.List[object]]$Rows)

    if (-not $OutCsv) { return }
    $lines = @(@($Rows) | ConvertTo-Csv -NoTypeInformation)
    if ($null -eq $lines) { $lines = @() }
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllLines($OutCsv, [string[]]$lines, $utf8NoBom)
}

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

Write-Host ("Target: {0}" -f $BaseUrl)
Write-Host ("Rule:   source.type = '{0}' AND createdAt < {1}{2}" -f $SourceType, (Format-Instant $cutoffUtc), $(if ($lowerUtc) { " AND createdAt >= $(Format-Instant $lowerUtc)" } else { '' }))
Write-Host ("Paging: pageSize={0}, sortBy=createdAt, order=asc, cursor style '{1}'" -f $PageSize, $CursorStyle)
if ($MaxDeletions -gt 0) { Write-Host ("Cap:    {0} deletion(s) this run" -f $MaxDeletions) }
if ($WhatIfPreference) { Write-Host "Mode:   -WhatIf (nothing will be deleted)" -ForegroundColor Yellow }

$auditRows = New-Object System.Collections.Generic.List[object]
$indeterminate = New-Object System.Collections.Generic.List[object]
$deletedIds = New-Object System.Collections.Generic.HashSet[string]
$deletedTotal = 0
$goneTotal = 0
$failedTotal = 0
$capReached = $false
$pass = 0
$confirmed = $false

while ($pass -lt $MaxPasses -and -not $capReached) {
    $pass++
    Write-Host ("--- Pass {0} ---" -f $pass)

    $indeterminate.Clear()   # re-derived every pass; only the last pass's view is reported
    $candidates = @(Find-CandidateTickets -ExcludeIds $deletedIds -Indeterminate $indeterminate)
    if ($candidates.Count -eq 0) { break }

    if ($pass -eq 1) {
        Write-Host ("Oldest match: {0} | newest match: {1}" -f `
            (Format-Instant $candidates[0].CreatedAtUtc), (Format-Instant $candidates[$candidates.Count - 1].CreatedAtUtc))
        if ($ThrottleMs -gt 0) {
            $estMin = [Math]::Round(($candidates.Count * $ThrottleMs) / 60000.0, 1)
            Write-Host ("Estimated delete time at {0} ms/call: ~{1} minute(s)." -f $ThrottleMs, $estMin)
        }
        Write-Host 'Matched tickets:'
        Write-TicketLines -Rows $candidates
    }

    # One bulk confirmation for the whole run - a per-ticket prompt is unusable at this
    # volume. -WhatIf still reports every ticket below; -Confirm still prompts per ticket.
    if (-not $WhatIfPreference -and -not $Force -and -not $confirmed) {
        $query = "Delete {0} API-created ticket(s) created before {1}? They move to the trash silo (purged after 30 days)." -f $candidates.Count, (Format-Instant $cutoffUtc)
        if (-not $PSCmdlet.ShouldContinue($query, 'Confirm ticket deletion')) {
            Write-Host 'Aborted - nothing deleted.' -ForegroundColor Yellow
            break
        }
        $confirmed = $true
    }

    $deletedThisPass = 0
    $index = 0
    foreach ($c in $candidates) {
        $index++
        if ($MaxDeletions -gt 0 -and $deletedTotal -ge $MaxDeletions) {
            Write-Warning ("Deletion cap of {0} reached; stopping. Re-run to continue." -f $MaxDeletions)
            $capReached = $true
            break
        }

        $label = "ticket {0} [#{1}] created {2} - {3}" -f $c.Id, $c.ShortId, (Format-Instant $c.CreatedAtUtc), $c.Subject
        $outcome = 'Skipped'

        Write-Progress -Activity ("Deleting tickets (pass {0})" -f $pass) `
            -Status ("{0}/{1} - {2}" -f $index, $candidates.Count, $c.Id) `
            -PercentComplete ([int](100 * $index / [Math]::Max(1, $candidates.Count)))

        if ($PSCmdlet.ShouldProcess($label, 'DELETE')) {
            try {
                Invoke-HelpdeskApi -Method Delete -Url "$BaseUrl/tickets/$($c.Id)" | Out-Null
                $outcome = 'Deleted'
                $deletedTotal++
                $deletedThisPass++
                [void]$deletedIds.Add($c.Id)
                Write-Verbose ("Deleted {0}" -f $label)
            }
            catch {
                $status = $null
                if ($_.Exception.Data -and $_.Exception.Data.Contains('StatusCode')) { $status = $_.Exception.Data['StatusCode'] }

                if ($status -eq 404) {
                    # Already gone: a concurrent delete, or an earlier attempt that landed.
                    $outcome = 'AlreadyGone'
                    $goneTotal++
                    [void]$deletedIds.Add($c.Id)
                    Write-Verbose ("Already gone: {0}" -f $label)
                }
                elseif ($status -eq 405 -or $status -eq 501) {
                    # The route doesn't accept DELETE at all - every later call fails the
                    # same way, so stop instead of hammering the API.
                    Write-Progress -Activity ("Deleting tickets (pass {0})" -f $pass) -Completed
                    Write-AuditCsv -Rows $auditRows
                    throw
                }
                else {
                    $outcome = 'Failed'
                    $failedTotal++
                    [void]$deletedIds.Add($c.Id)   # don't retry it forever across passes
                    Write-Warning ("Delete failed for {0}: {1}" -f $label, $_.Exception.Message)
                }
            }
        }

        [void]$auditRows.Add([PSCustomObject]@{
                TicketID   = $c.Id
                ShortID    = $c.ShortId
                Subject    = $c.Subject
                Requester  = $c.Requester
                SourceType = $c.SourceType
                CreatedAt  = Format-Instant $c.CreatedAtUtc
                Pass       = $pass
                Outcome    = $outcome
            })
    }

    Write-Progress -Activity ("Deleting tickets (pass {0})" -f $pass) -Completed
    Write-AuditCsv -Rows $auditRows
    Write-Host ("Pass {0}: deleted {1} of {2} candidate(s)." -f $pass, $deletedThisPass, $candidates.Count)

    # Nothing actually left the server this pass (-WhatIf, declined confirmation, or every
    # delete failed) - re-scanning would return the same set forever.
    if ($deletedThisPass -eq 0) { break }
}

if ($pass -ge $MaxPasses) { Write-Warning ("Stopped at the {0}-pass limit; re-run to continue." -f $MaxPasses) }

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

if ($indeterminate.Count -gt 0) {
    Write-Warning ("{0} ticket(s) had an unreadable source or createdAt and were NOT touched:" -f $indeterminate.Count)
    Write-TicketLines -Rows $indeterminate
}

if ($OutCsv -and $auditRows.Count -gt 0) {
    Write-Host ("Wrote {0} audit row(s) to {1}" -f $auditRows.Count, $OutCsv)
}

Write-Host ("Deleted: {0} | Already gone: {1} | Failed: {2} | Indeterminate: {3} | Passes: {4}" -f `
        $deletedTotal, $goneTotal, $failedTotal, $indeterminate.Count, $pass)

if ($WhatIfPreference) {
    Write-Host ("No tickets were deleted (-WhatIf). {0} would have been. Re-run with -Force to commit." -f $auditRows.Count) -ForegroundColor Yellow
}
