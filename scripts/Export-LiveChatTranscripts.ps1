<#
.SYNOPSIS
    Downloads archived LiveChat transcripts into year/month folders.

.DESCRIPTION
    Calls the Text (LiveChat) Agent Chat API v3.6 list_archives action and
    downloads every archived thread in the requested UTC month range.

    Each thread is saved twice by default:
      - JSON: the complete API object, suitable for preservation/reprocessing.
      - TXT:  a human-readable transcript.

    A _manifest.csv file is also written in each queried month folder. Existing
    transcript files are skipped, making an interrupted export safe to resume.
    Use -Force to refresh files that have already been downloaded.

    The output layout is:

        <OutputPath>/
          2025/
            01/
              <chat-id>_<thread-id>.json
              <chat-id>_<thread-id>.txt
              _manifest.csv

    Dates and folders use UTC because Agent Chat event and thread timestamps are
    returned in UTC.

.PARAMETER FromMonth
    First month to export, inclusive, in YYYY-MM format.

.PARAMETER ToMonth
    Last month to export, inclusive, in YYYY-MM format. Defaults to the current
    UTC month.

.PARAMETER OutputPath
    Root export folder. Defaults to ./livechat-transcripts.

.PARAMETER EncodedToken
    Base64-encoded "<account_id>:<personal_access_token>" credential. Defaults
    to LIVECHAT_BASIC_TOKEN. It may optionally include the "Basic " prefix.

.PARAMETER AccountId
    LiveChat account ID. Used with -PersonalAccessToken when -EncodedToken is
    not supplied. Defaults to LIVECHAT_ACCOUNT_ID.

.PARAMETER PersonalAccessToken
    Raw LiveChat Personal Access Token. Used with -AccountId when
    -EncodedToken is not supplied. Defaults to LIVECHAT_PAT.

.PARAMETER GroupId
    Optional LiveChat group IDs to include. By default, all groups visible to
    the account represented by the token are exported.

.PARAMETER NoText
    Save the complete JSON records and manifests, but omit readable TXT files.

.PARAMETER Force
    Overwrite transcript files that already exist.

.PARAMETER BaseUrl
    Agent Chat API action base URL. Defaults to the stable v3.6 endpoint.

.PARAMETER PageSize
    Archive records requested per API page. Maximum and default: 100.

.PARAMETER MaxRetries
    Number of retries for rate limits and transient HTTP failures.

.EXAMPLE
    $env:LIVECHAT_BASIC_TOKEN = '<base64 credential from Developer Console>'
    .\scripts\Export-LiveChatTranscripts.ps1 -FromMonth 2024-01

.EXAMPLE
    $env:LIVECHAT_ACCOUNT_ID = '<account id>'
    $env:LIVECHAT_PAT = '<personal access token>'
    .\scripts\Export-LiveChatTranscripts.ps1 `
        -FromMonth 2025-01 -ToMonth 2025-12 `
        -OutputPath D:\Exports\LiveChat

.EXAMPLE
    # Resume the export, restricted to two LiveChat groups.
    .\scripts\Export-LiveChatTranscripts.ps1 `
        -FromMonth 2026-01 -GroupId 1,4 -NoText

.NOTES
    Requires a PAT with chats--all:ro (all groups) or chats--access:ro (only
    groups available to the token owner). Compatible with Windows PowerShell
    5.1 and PowerShell 7+.

    This exports transcript metadata and file-event URLs. It does not download
    files attached to chats.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$FromMonth,

    [string]$ToMonth = [DateTimeOffset]::UtcNow.ToString('yyyy-MM'),

    [string]$OutputPath = (Join-Path (Get-Location) 'livechat-transcripts'),

    [string]$EncodedToken = $env:LIVECHAT_BASIC_TOKEN,

    [string]$AccountId = $env:LIVECHAT_ACCOUNT_ID,

    [string]$PersonalAccessToken = $env:LIVECHAT_PAT,

    [ValidateCount(1, 200)]
    [ValidateRange(0, 2147483647)]
    [int[]]$GroupId,

    [switch]$NoText,

    [switch]$Force,

    [string]$BaseUrl = 'https://api.livechatinc.com/v3.6/agent/action',

    [ValidateRange(1, 100)]
    [int]$PageSize = 100,

    [ValidateRange(0, 20)]
    [int]$MaxRetries = 5
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

try {
    [Net.ServicePointManager]::SecurityProtocol =
        [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
}
catch {
    # PowerShell 7 negotiates modern TLS itself, and some constrained hosts do
    # not expose this setting.
    Write-Verbose "Could not explicitly enable TLS 1.2; using the host's configured protocols."
}

$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$script:InvariantCulture = [Globalization.CultureInfo]::InvariantCulture
$script:ArchiveUrl = $BaseUrl.TrimEnd('/') + '/list_archives'

function Get-ObjectProperty {
    param(
        $InputObject,
        [Parameter(Mandatory)] [string]$Name
    )

    if ($null -eq $InputObject) {
        return $null
    }

    $property = $InputObject.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return $null
    }

    return $property.Value
}

function ConvertTo-MonthStart {
    param(
        [Parameter(Mandatory)] [string]$Value,
        [Parameter(Mandatory)] [string]$ParameterName
    )

    $match = [regex]::Match($Value, '^(?<year>\d{4})-(?<month>0[1-9]|1[0-2])$')
    if (-not $match.Success) {
        throw "-$ParameterName must use YYYY-MM format; received '$Value'."
    }

    $year = [int]$match.Groups['year'].Value
    $month = [int]$match.Groups['month'].Value
    if ($year -lt 1 -or $year -gt 9999) {
        throw "-$ParameterName year must be between 0001 and 9999."
    }

    return New-Object DateTimeOffset($year, $month, 1, 0, 0, 0, [TimeSpan]::Zero)
}

function ConvertTo-ApiTimestamp {
    param([Parameter(Mandatory)] [DateTimeOffset]$Value)

    # The API documents RFC3339 timestamps with microsecond resolution.
    return $Value.ToUniversalTime().ToString(
        "yyyy-MM-dd'T'HH:mm:ss.ffffff'Z'",
        $script:InvariantCulture
    )
}

function ConvertFrom-ApiTimestamp {
    param(
        [string]$Value,
        [string]$Description = 'timestamp'
    )

    if ([string]::IsNullOrWhiteSpace($Value)) {
        throw "The API returned an empty $Description."
    }

    $parsed = [DateTimeOffset]::MinValue
    $ok = [DateTimeOffset]::TryParse(
        $Value,
        $script:InvariantCulture,
        [Globalization.DateTimeStyles]::RoundtripKind,
        [ref]$parsed
    )
    if (-not $ok) {
        throw "The API returned an invalid ${Description}: '$Value'."
    }

    return $parsed.ToUniversalTime()
}

function Get-HttpStatusCode {
    param($ErrorRecord)

    if (-not $ErrorRecord.Exception) {
        return $null
    }

    $responseProperty = $ErrorRecord.Exception.PSObject.Properties['Response']
    if ($null -eq $responseProperty -or $null -eq $responseProperty.Value) {
        return $null
    }

    $statusProperty = $responseProperty.Value.PSObject.Properties['StatusCode']
    if ($null -eq $statusProperty -or $null -eq $statusProperty.Value) {
        return $null
    }

    try {
        return [int]$statusProperty.Value
    }
    catch {
        return $null
    }
}

function Get-HttpErrorBody {
    param($ErrorRecord)

    if ($ErrorRecord.ErrorDetails -and $ErrorRecord.ErrorDetails.Message) {
        return [string]$ErrorRecord.ErrorDetails.Message
    }

    if (-not $ErrorRecord.Exception) {
        return $null
    }

    $responseProperty = $ErrorRecord.Exception.PSObject.Properties['Response']
    if ($null -eq $responseProperty -or $null -eq $responseProperty.Value) {
        return $null
    }
    $response = $responseProperty.Value

    try {
        if (($response -is [Net.HttpWebResponse]) -or
            ($response.PSObject.Methods.Name -contains 'GetResponseStream')) {
            $stream = $response.GetResponseStream()
            if ($stream) {
                $reader = New-Object IO.StreamReader($stream)
                try {
                    return $reader.ReadToEnd()
                }
                finally {
                    $reader.Dispose()
                }
            }
        }
    }
    catch {
        # Fall through to the PowerShell 7 response shape.
        Write-Verbose 'Could not read the HTTP error body as an HttpWebResponse stream.'
    }

    try {
        $contentProperty = $response.PSObject.Properties['Content']
        if ($contentProperty -and $contentProperty.Value) {
            $content = $contentProperty.Value
            if ($content.PSObject.Methods.Name -contains 'ReadAsStringAsync') {
                return $content.ReadAsStringAsync().Result
            }
        }
    }
    catch {
        # No usable response body.
        Write-Verbose 'Could not read the HTTP error body as HttpResponseMessage content.'
    }

    return $null
}

function Get-RetryAfterDelay {
    param($ErrorRecord)

    if (-not $ErrorRecord.Exception) {
        return $null
    }

    $responseProperty = $ErrorRecord.Exception.PSObject.Properties['Response']
    if ($null -eq $responseProperty -or $null -eq $responseProperty.Value) {
        return $null
    }
    $response = $responseProperty.Value
    $rawValue = $null

    try {
        if ($response -is [Net.HttpWebResponse]) {
            $rawValue = $response.Headers['Retry-After']
        }
        else {
            $headersProperty = $response.PSObject.Properties['Headers']
            if ($headersProperty -and $headersProperty.Value) {
                $retryAfter = $headersProperty.Value.RetryAfter
                if ($retryAfter) {
                    if ($retryAfter.Delta) {
                        return [Math]::Max(0, [int][Math]::Ceiling($retryAfter.Delta.TotalSeconds))
                    }
                    if ($retryAfter.Date) {
                        return [Math]::Max(
                            0,
                            [int][Math]::Ceiling(
                                ($retryAfter.Date - [DateTimeOffset]::UtcNow).TotalSeconds
                            )
                        )
                    }
                    $rawValue = [string]$retryAfter
                }
            }
        }
    }
    catch {
        return $null
    }

    if ([string]::IsNullOrWhiteSpace([string]$rawValue)) {
        return $null
    }

    $seconds = 0
    if ([int]::TryParse([string]$rawValue, [ref]$seconds)) {
        return [Math]::Max(0, $seconds)
    }

    $retryDate = [DateTimeOffset]::MinValue
    if ([DateTimeOffset]::TryParse(
            [string]$rawValue,
            $script:InvariantCulture,
            [Globalization.DateTimeStyles]::AllowWhiteSpaces,
            [ref]$retryDate
        )) {
        return [Math]::Max(
            0,
            [int][Math]::Ceiling(($retryDate - [DateTimeOffset]::UtcNow).TotalSeconds)
        )
    }

    return $null
}

function Invoke-LiveChatArchiveRequest {
    param(
        [Parameter(Mandatory)] [hashtable]$Payload,
        [Parameter(Mandatory)] [int]$RetryCount
    )

    $json = $Payload | ConvertTo-Json -Depth 30 -Compress
    $bodyBytes = [Text.Encoding]::UTF8.GetBytes($json)
    $retryableStatuses = @(408, 429, 500, 502, 503, 504)

    for ($attempt = 0; $attempt -le $RetryCount; $attempt++) {
        try {
            return Invoke-RestMethod `
                -Method Post `
                -Uri $script:ArchiveUrl `
                -Headers $script:RequestHeaders `
                -ContentType 'application/json; charset=utf-8' `
                -Body $bodyBytes `
                -ErrorAction Stop
        }
        catch {
            $status = Get-HttpStatusCode -ErrorRecord $_
            $canRetry = ($attempt -lt $RetryCount) -and
                (($null -eq $status) -or ($retryableStatuses -contains $status))

            if ($canRetry) {
                $delay = Get-RetryAfterDelay -ErrorRecord $_
                if ($null -eq $delay) {
                    $delay = [Math]::Min(30, [Math]::Pow(2, $attempt))
                }
                # Avoid a malformed or very long server value making the script
                # appear to hang indefinitely.
                $delay = [Math]::Min(60, [Math]::Max(1, [int]$delay))
                Write-Warning (
                    "Archive request failed{0}; retrying in {1}s (attempt {2} of {3})." -f
                    $(if ($null -ne $status) { " with HTTP $status" } else { '' }),
                    $delay,
                    ($attempt + 1),
                    $RetryCount
                )
                Start-Sleep -Seconds $delay
                continue
            }

            $message = "LiveChat archive request failed"
            if ($null -ne $status) {
                $message += " with HTTP $status"
            }
            $message += "."

            switch ($status) {
                401 {
                    $message += ' Check the account ID/PAT or LIVECHAT_BASIC_TOKEN.'
                }
                403 {
                    $message += ' The token needs chats--all:ro or chats--access:ro scope.'
                }
                429 {
                    $message += ' The API rate limit remained active after all retries.'
                }
            }

            $errorBody = Get-HttpErrorBody -ErrorRecord $_
            if ($errorBody) {
                if ($errorBody.Length -gt 4000) {
                    $errorBody = $errorBody.Substring(0, 4000) + '...'
                }
                $message += [Environment]::NewLine + 'Response body: ' + $errorBody
            }

            throw $message
        }
    }
}

function ConvertTo-SafeFilePart {
    param(
        [string]$Value,
        [string]$Fallback
    )

    if ([string]::IsNullOrWhiteSpace($Value)) {
        $Value = $Fallback
    }

    $safe = [regex]::Replace($Value, '[\\/:*?"<>|]', '_')
    $safe = [regex]::Replace($safe, '[\x00-\x1f]', '_')
    $safe = $safe.Trim().TrimEnd('.')
    if ([string]::IsNullOrWhiteSpace($safe)) {
        $safe = $Fallback
    }
    if ($safe.Length -gt 100) {
        $safe = $safe.Substring(0, 100)
    }
    return $safe
}

function Write-Utf8File {
    param(
        [Parameter(Mandatory)] [string]$Path,
        [Parameter(Mandatory)] [AllowEmptyString()] [string]$Content
    )

    $directory = [IO.Path]::GetDirectoryName($Path)
    if (-not [IO.Directory]::Exists($directory)) {
        [void][IO.Directory]::CreateDirectory($directory)
    }

    $operationId = $PID.ToString() + '-' + [Guid]::NewGuid().ToString('N')
    $tempPath = $Path + '.tmp-' + $operationId
    $backupPath = $Path + '.backup-' + $operationId
    try {
        [IO.File]::WriteAllText($tempPath, $Content, $script:Utf8NoBom)
        if ([IO.File]::Exists($Path)) {
            [IO.File]::Replace($tempPath, $Path, $backupPath)
            [IO.File]::Delete($backupPath)
        }
        else {
            [IO.File]::Move($tempPath, $Path)
        }
    }
    finally {
        if (Test-Path -LiteralPath $tempPath -PathType Leaf) {
            Remove-Item -LiteralPath $tempPath -Force
        }
        if (Test-Path -LiteralPath $backupPath -PathType Leaf) {
            Remove-Item -LiteralPath $backupPath -Force
        }
    }
}

function ConvertTo-DisplayValue {
    param($Value)

    if ($null -eq $Value) {
        return ''
    }
    if ($Value -is [string]) {
        return $Value
    }
    if ($Value -is [ValueType]) {
        return [string]$Value
    }

    return ($Value | ConvertTo-Json -Depth 20 -Compress)
}

function Get-UserLabel {
    param($User)

    $id = [string](Get-ObjectProperty -InputObject $User -Name 'id')
    $name = [string](Get-ObjectProperty -InputObject $User -Name 'name')
    $email = [string](Get-ObjectProperty -InputObject $User -Name 'email')
    $type = [string](Get-ObjectProperty -InputObject $User -Name 'type')

    $label = $name
    if ([string]::IsNullOrWhiteSpace($label)) {
        $label = $email
    }
    if ([string]::IsNullOrWhiteSpace($label)) {
        $label = $id
    }
    if ([string]::IsNullOrWhiteSpace($label)) {
        $label = 'unknown user'
    }

    if (-not [string]::IsNullOrWhiteSpace($email) -and $email -ne $label) {
        $label += " <$email>"
    }
    if (-not [string]::IsNullOrWhiteSpace($type)) {
        $label += " [$type]"
    }

    return $label
}

function ConvertTo-FormFieldText {
    param($ChatEvent)

    $lines = New-Object Collections.Generic.List[string]
    foreach ($field in @(Get-ObjectProperty -InputObject $ChatEvent -Name 'fields')) {
        if ($null -eq $field) {
            continue
        }

        $label = [string](Get-ObjectProperty -InputObject $field -Name 'label')
        if ([string]::IsNullOrWhiteSpace($label)) {
            $label = [string](Get-ObjectProperty -InputObject $field -Name 'type')
        }

        $answer = Get-ObjectProperty -InputObject $field -Name 'answer'
        if ($null -eq $answer) {
            $answer = Get-ObjectProperty -InputObject $field -Name 'answers'
        }
        if ($null -eq $answer) {
            $answer = Get-ObjectProperty -InputObject $field -Name 'options'
        }

        [void]$lines.Add(('  {0}: {1}' -f $label, (ConvertTo-DisplayValue $answer)))
    }

    return ($lines -join [Environment]::NewLine)
}

function Format-EventBody {
    param($ChatEvent)

    $type = [string](Get-ObjectProperty -InputObject $ChatEvent -Name 'type')
    switch ($type) {
        'message' {
            return [string](Get-ObjectProperty -InputObject $ChatEvent -Name 'text')
        }
        'file' {
            $name = [string](Get-ObjectProperty -InputObject $ChatEvent -Name 'name')
            $contentType = [string](Get-ObjectProperty -InputObject $ChatEvent -Name 'content_type')
            $size = Get-ObjectProperty -InputObject $ChatEvent -Name 'size'
            $url = [string](Get-ObjectProperty -InputObject $ChatEvent -Name 'url')
            $details = @($contentType, $(if ($null -ne $size) { "$size bytes" } else { $null })) |
                Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }
            return '[file] {0}{1}{2}' -f
                $name,
                $(if ($details.Count -gt 0) { ' (' + ($details -join ', ') + ')' } else { '' }),
                $(if ($url) { [Environment]::NewLine + $url } else { '' })
        }
        { $_ -eq 'form' -or $_ -eq 'filled_form' } {
            $formType = [string](Get-ObjectProperty -InputObject $ChatEvent -Name 'form_type')
            $heading = "[$type]"
            if ($formType) {
                $heading += " $formType"
            }
            $fields = ConvertTo-FormFieldText -ChatEvent $ChatEvent
            if ($fields) {
                return $heading + [Environment]::NewLine + $fields
            }
            return $heading
        }
        'rich_message' {
            $template = [string](Get-ObjectProperty -InputObject $ChatEvent -Name 'template_id')
            $lines = New-Object Collections.Generic.List[string]
            [void]$lines.Add("[rich_message] $template")
            foreach ($element in @(Get-ObjectProperty -InputObject $ChatEvent -Name 'elements')) {
                if ($null -eq $element) {
                    continue
                }
                $title = [string](Get-ObjectProperty -InputObject $element -Name 'title')
                $subtitle = [string](Get-ObjectProperty -InputObject $element -Name 'subtitle')
                if ($title) {
                    [void]$lines.Add("  $title")
                }
                if ($subtitle) {
                    [void]$lines.Add("  $subtitle")
                }
                foreach ($button in @(Get-ObjectProperty -InputObject $element -Name 'buttons')) {
                    if ($null -eq $button) {
                        continue
                    }
                    $buttonText = [string](Get-ObjectProperty -InputObject $button -Name 'text')
                    $buttonValue = [string](Get-ObjectProperty -InputObject $button -Name 'value')
                    [void]$lines.Add(
                        (
                            '  [button] {0}{1}' -f
                            $buttonText,
                            $(if ($buttonValue) { ": $buttonValue" } else { '' })
                        )
                    )
                }
            }
            return ($lines -join [Environment]::NewLine)
        }
        'system_message' {
            $systemType = [string](Get-ObjectProperty -InputObject $ChatEvent -Name 'system_message_type')
            $text = [string](Get-ObjectProperty -InputObject $ChatEvent -Name 'text')
            return '[system] {0}{1}' -f
                $systemType,
                $(if ($text) { ": $text" } else { '' })
        }
        'custom' {
            $content = Get-ObjectProperty -InputObject $ChatEvent -Name 'content'
            return '[custom] ' + (ConvertTo-DisplayValue $content)
        }
        default {
            return "[$type] " + ($ChatEvent | ConvertTo-Json -Depth 20 -Compress)
        }
    }
}

function ConvertTo-TranscriptText {
    param([Parameter(Mandatory)] $Chat)

    $chatId = [string](Get-ObjectProperty -InputObject $Chat -Name 'id')
    $thread = Get-ObjectProperty -InputObject $Chat -Name 'thread'
    $threadId = [string](Get-ObjectProperty -InputObject $thread -Name 'id')
    $threadCreated = [string](Get-ObjectProperty -InputObject $thread -Name 'created_at')
    $threadActive = Get-ObjectProperty -InputObject $thread -Name 'active'
    $users = @(Get-ObjectProperty -InputObject $Chat -Name 'users')

    $userLabels = @{}
    foreach ($user in $users) {
        if ($null -eq $user) {
            continue
        }
        $id = [string](Get-ObjectProperty -InputObject $user -Name 'id')
        if ($id) {
            $userLabels[$id] = Get-UserLabel -User $user
        }
    }

    $builder = New-Object Text.StringBuilder
    [void]$builder.AppendLine("LiveChat transcript")
    [void]$builder.AppendLine("Chat ID: $chatId")
    [void]$builder.AppendLine("Thread ID: $threadId")
    [void]$builder.AppendLine("Thread created (UTC): $threadCreated")
    [void]$builder.AppendLine("Thread active: $threadActive")
    [void]$builder.AppendLine('Participants:')
    foreach ($user in $users) {
        if ($null -ne $user) {
            [void]$builder.AppendLine('  - ' + (Get-UserLabel -User $user))
        }
    }
    [void]$builder.AppendLine()
    [void]$builder.AppendLine('Events:')

    foreach ($chatEvent in @(Get-ObjectProperty -InputObject $thread -Name 'events')) {
        if ($null -eq $chatEvent) {
            continue
        }

        $createdAt = [string](Get-ObjectProperty -InputObject $chatEvent -Name 'created_at')
        $authorId = [string](Get-ObjectProperty -InputObject $chatEvent -Name 'author_id')
        $eventType = [string](Get-ObjectProperty -InputObject $chatEvent -Name 'type')
        $visibility = [string](Get-ObjectProperty -InputObject $chatEvent -Name 'visibility')
        $author = $authorId
        if ($authorId -and $userLabels.ContainsKey($authorId)) {
            $author = $userLabels[$authorId]
        }
        if ([string]::IsNullOrWhiteSpace($author)) {
            $author = 'system'
        }

        [void]$builder.AppendLine(
            (
                '[{0}] {1} ({2}, visibility: {3})' -f
                $createdAt,
                $author,
                $eventType,
                $visibility
            )
        )
        [void]$builder.AppendLine((Format-EventBody -ChatEvent $chatEvent))
        [void]$builder.AppendLine()
    }

    return $builder.ToString()
}

function ConvertTo-ManifestRow {
    param(
        [Parameter(Mandatory)] $Chat,
        [Parameter(Mandatory)] [DateTimeOffset]$CreatedAt,
        [Parameter(Mandatory)] [string]$JsonRelativePath,
        [string]$TextRelativePath
    )

    $thread = Get-ObjectProperty -InputObject $Chat -Name 'thread'
    $users = @(Get-ObjectProperty -InputObject $Chat -Name 'users')
    $customers = @($users | Where-Object {
        [string](Get-ObjectProperty -InputObject $_ -Name 'type') -eq 'customer'
    })
    $agents = @($users | Where-Object {
        [string](Get-ObjectProperty -InputObject $_ -Name 'type') -eq 'agent'
    })

    $customer = $null
    if ($customers.Count -gt 0) {
        $customer = $customers[0]
    }

    $customerName = [string](Get-ObjectProperty -InputObject $customer -Name 'name')
    $customerEmail = [string](Get-ObjectProperty -InputObject $customer -Name 'email')
    $agentNames = @($agents | ForEach-Object {
        $name = [string](Get-ObjectProperty -InputObject $_ -Name 'name')
        if (-not $name) {
            $name = [string](Get-ObjectProperty -InputObject $_ -Name 'email')
        }
        if (-not $name) {
            $name = [string](Get-ObjectProperty -InputObject $_ -Name 'id')
        }
        $name
    })
    $events = @(Get-ObjectProperty -InputObject $thread -Name 'events')
    $groupIds = @(
        Get-ObjectProperty `
            -InputObject (Get-ObjectProperty -InputObject $thread -Name 'access') `
            -Name 'group_ids'
    )

    return [PSCustomObject]@{
        CreatedAtUtc = $CreatedAt.ToString('o')
        ChatId = [string](Get-ObjectProperty -InputObject $Chat -Name 'id')
        ThreadId = [string](Get-ObjectProperty -InputObject $thread -Name 'id')
        Active = [string](Get-ObjectProperty -InputObject $thread -Name 'active')
        CustomerName = $customerName
        CustomerEmail = $customerEmail
        AgentNames = ($agentNames -join '; ')
        GroupIds = (($groupIds | ForEach-Object { [string]$_ }) -join ';')
        EventCount = $events.Count
        JsonFile = $JsonRelativePath
        TextFile = $TextRelativePath
    }
}

function Write-MonthManifest {
    param(
        [Parameter(Mandatory)] [string]$Path,
        [Parameter(Mandatory)] [AllowEmptyCollection()] [object[]]$Rows
    )

    if ($Rows.Count -gt 0) {
        $lines = @($Rows | Sort-Object CreatedAtUtc, ChatId, ThreadId | ConvertTo-Csv -NoTypeInformation)
    }
    else {
        $lines = @(
            '"CreatedAtUtc","ChatId","ThreadId","Active","CustomerName","CustomerEmail","AgentNames","GroupIds","EventCount","JsonFile","TextFile"'
        )
    }

    Write-Utf8File -Path $Path -Content (($lines -join [Environment]::NewLine) + [Environment]::NewLine)
}

# Resolve the requested month range.
$fromStart = ConvertTo-MonthStart -Value $FromMonth -ParameterName 'FromMonth'
$toStart = ConvertTo-MonthStart -Value $ToMonth -ParameterName 'ToMonth'
if ($fromStart -gt $toStart) {
    throw "-FromMonth ($FromMonth) must not be later than -ToMonth ($ToMonth)."
}

# Resolve authentication without placing credentials in the script or output.
$encodedCredential = $EncodedToken
if (-not [string]::IsNullOrWhiteSpace($encodedCredential)) {
    $encodedCredential = $encodedCredential.Trim()
    if ($encodedCredential.StartsWith('Basic ', [StringComparison]::OrdinalIgnoreCase)) {
        $encodedCredential = $encodedCredential.Substring(6).Trim()
    }
}
elseif (-not [string]::IsNullOrWhiteSpace($AccountId) -and
        -not [string]::IsNullOrWhiteSpace($PersonalAccessToken)) {
    $rawCredential = '{0}:{1}' -f $AccountId, $PersonalAccessToken
    $encodedCredential = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($rawCredential))
}
else {
    throw @'
No LiveChat credential was supplied. Either:
  - set LIVECHAT_BASIC_TOKEN (the Base64 credential from Developer Console), or
  - set both LIVECHAT_ACCOUNT_ID and LIVECHAT_PAT.
You can also pass the corresponding script parameters explicitly.
'@
}

$script:RequestHeaders = @{
    Authorization = "Basic $encodedCredential"
    Accept = 'application/json'
    'User-Agent' = 'helpdeskcom-relay-transcript-export/1.0'
}

$resolvedOutputPath = [IO.Path]::GetFullPath($OutputPath)
[void][IO.Directory]::CreateDirectory($resolvedOutputPath)

$totalRecords = 0
$totalWritten = 0
$totalSkipped = 0
$monthCursor = $fromStart

while ($monthCursor -le $toStart) {
    $nextMonth = $monthCursor.AddMonths(1)
    # API timestamps have microsecond resolution, so query through the final
    # microsecond of the month without overlapping the next month's request.
    $monthEnd = $nextMonth.AddTicks(-10)
    $yearFolder = Join-Path $resolvedOutputPath $monthCursor.ToString('yyyy')
    $queryMonthFolder = Join-Path $yearFolder $monthCursor.ToString('MM')
    [void][IO.Directory]::CreateDirectory($queryMonthFolder)

    Write-Information -InformationAction Continue -MessageData (
        'Exporting {0:yyyy-MM} ({1} through {2}, UTC)...' -f
        $monthCursor,
        (ConvertTo-ApiTimestamp $monthCursor),
        (ConvertTo-ApiTimestamp $monthEnd)
    )

    $filters = @{
        from = (ConvertTo-ApiTimestamp -Value $monthCursor)
        to = (ConvertTo-ApiTimestamp -Value $monthEnd)
    }
    if ($GroupId -and $GroupId.Count -gt 0) {
        $filters['group_ids'] = @($GroupId)
    }

    $request = @{
        filters = $filters
        sort_order = 'asc'
        limit = $PageSize
    }

    $manifestRows = New-Object Collections.Generic.List[object]
    $seenThreadIds = @{}
    $pageNumber = 0
    $monthRecords = 0
    $nextPageId = $null

    do {
        $pageNumber++
        if ($pageNumber -gt 100000) {
            throw "Pagination safety limit exceeded while exporting $($monthCursor.ToString('yyyy-MM'))."
        }

        if ($nextPageId) {
            # The API requires page_id by itself: filters, limit, and sort_order
            # from the first request are retained by the server.
            $request = @{ page_id = $nextPageId }
        }

        Write-Verbose (
            'Requesting {0:yyyy-MM} archive page {1}{2}.' -f
            $monthCursor,
            $pageNumber,
            $(if ($nextPageId) { " (page_id $nextPageId)" } else { '' })
        )
        $response = Invoke-LiveChatArchiveRequest -Payload $request -RetryCount $MaxRetries
        $chats = @(Get-ObjectProperty -InputObject $response -Name 'chats')

        foreach ($chat in $chats) {
            if ($null -eq $chat) {
                continue
            }

            $thread = Get-ObjectProperty -InputObject $chat -Name 'thread'
            $chatId = [string](Get-ObjectProperty -InputObject $chat -Name 'id')
            $threadId = [string](Get-ObjectProperty -InputObject $thread -Name 'id')
            if ([string]::IsNullOrWhiteSpace($threadId)) {
                throw "The API returned chat '$chatId' without a thread ID."
            }
            if ($seenThreadIds.ContainsKey($threadId)) {
                Write-Warning "Skipping duplicate thread '$threadId' returned during pagination."
                continue
            }
            $seenThreadIds[$threadId] = $true

            $createdAtRaw = [string](Get-ObjectProperty -InputObject $thread -Name 'created_at')
            $createdAt = ConvertFrom-ApiTimestamp `
                -Value $createdAtRaw `
                -Description "created_at for thread '$threadId'"

            # Folder placement is based on the actual thread timestamp, even if
            # an API boundary ever returns an adjacent-month record.
            $recordYearFolder = Join-Path $resolvedOutputPath $createdAt.ToString('yyyy')
            $recordMonthFolder = Join-Path $recordYearFolder $createdAt.ToString('MM')
            [void][IO.Directory]::CreateDirectory($recordMonthFolder)

            $safeChatId = ConvertTo-SafeFilePart -Value $chatId -Fallback 'unknown-chat'
            $safeThreadId = ConvertTo-SafeFilePart -Value $threadId -Fallback 'unknown-thread'
            $baseName = '{0}_{1}' -f $safeChatId, $safeThreadId
            $jsonPath = Join-Path $recordMonthFolder ($baseName + '.json')
            $textPath = Join-Path $recordMonthFolder ($baseName + '.txt')
            $relativeJson = '{0}/{1}/{2}.json' -f
                $createdAt.ToString('yyyy'),
                $createdAt.ToString('MM'),
                $baseName
            $relativeText = ''
            if (-not $NoText) {
                $relativeText = '{0}/{1}/{2}.txt' -f
                    $createdAt.ToString('yyyy'),
                    $createdAt.ToString('MM'),
                    $baseName
            }

            $jsonExists = Test-Path -LiteralPath $jsonPath -PathType Leaf
            $textExists = $NoText -or (Test-Path -LiteralPath $textPath -PathType Leaf)
            if (-not $Force -and $jsonExists -and $textExists) {
                $totalSkipped++
            }
            else {
                if ($Force -or -not $jsonExists) {
                    $chatJson = $chat | ConvertTo-Json -Depth 100
                    Write-Utf8File -Path $jsonPath -Content ($chatJson + [Environment]::NewLine)
                }
                if (-not $NoText -and ($Force -or -not $textExists)) {
                    $transcript = ConvertTo-TranscriptText -Chat $chat
                    Write-Utf8File -Path $textPath -Content $transcript
                }
                $totalWritten++
            }

            [void]$manifestRows.Add(
                (ConvertTo-ManifestRow `
                    -Chat $chat `
                    -CreatedAt $createdAt `
                    -JsonRelativePath $relativeJson `
                    -TextRelativePath $relativeText)
            )
            $monthRecords++
            $totalRecords++
        }

        $nextPageIdValue = Get-ObjectProperty -InputObject $response -Name 'next_page_id'
        $nextPageId = if ($nextPageIdValue) { [string]$nextPageIdValue } else { $null }
    }
    while ($nextPageId)

    $manifestPath = Join-Path $queryMonthFolder '_manifest.csv'
    Write-MonthManifest -Path $manifestPath -Rows $manifestRows.ToArray()
    Write-Information -InformationAction Continue -MessageData (
        'Completed {0:yyyy-MM}: {1} thread(s) across {2} page(s).' -f
        $monthCursor,
        $monthRecords,
        $pageNumber
    )

    $monthCursor = $nextMonth
}

Write-Information -InformationAction Continue -MessageData (
    'Export complete: {0} thread(s) found; {1} written or completed; {2} already present. Output: {3}' -f
    $totalRecords,
    $totalWritten,
    $totalSkipped,
    $resolvedOutputPath
)
