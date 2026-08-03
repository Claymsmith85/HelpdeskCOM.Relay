


  # (Windows PowerShell 5.1 only) uncomment if the call fails to negotiate TLS:
# [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$headers = @{ Authorization = "Basic $HELPDESK_PAT" }

# What teamIDs does the API actually return per agent?
Invoke-RestMethod -Uri 'https://api.helpdesk.com/v1/agents' -Headers $headers -UserAgent 'cs-debug/1.0' |
  Select-Object email, teamIDs | ConvertTo-Json

# Real team UUIDs — compare against rule.team in team-mapping.ts
Invoke-RestMethod -Uri 'https://api.helpdesk.com/v1/teams' -Headers $headers -UserAgent 'cs-debug/1.0' |
  Select-Object ID, name | ConvertTo-Json


curl -s https://api.helpdesk.com/v1/agents `
  -H "Authorization: Basic $HELPDESK_PAT" `
  -H "User-Agent: cs-debug/1.0"


