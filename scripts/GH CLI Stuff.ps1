


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


$Repo = "corespecialty/CoreSpecialty.Mail.helpdeskcom.relay"   # the actual live repo

foreach ($Env in "Production", "Development") {
    gh api -X PUT "repos/$Repo/environments/$Env" --silent
    foreach ($Var in "MAILBOX_DRAIN", "TICKET_CREATE", "SUBMITTER_REPLIES", "AGENT_NOTICES", "FOLLOWERS_NOTICES") {
        gh variable set $Var --env $Env --body "false" -R $Repo
    }
}

# verify
gh variable list --env Production -R $Repo
gh variable list --env Development -R $Repo


gh variable set MAIL_QUEUE_CLEAR_ON_STARTUP --env Production --body "false" -R $Repo   # go-live instant
gh variable set CREATE_TICKET --env Production --body "false" -R $Repo   # go-live instant


gh variable set MAIL_IGNORE_BEFORE --env Production --body "2026-08-08T00:00:00Z" -R $Repo   # go-live instant

gh variable set TICKET_CREATE --env Production --body "false" -R $Repo   # go-live instant



#Prod
$env:REQUESTS_CA_BUNDLE = "$env:USERPROFILE\Zscaler Root.cer"
az monitor app-insights query --app fb576bae-2a09-465f-9130-56a8ac1bbe64 -o json --analytics-query `
 "traces | where timestamp > ago(20m) | where cloud_RoleName == 'funcapp-core-helpdesk-prod000' | where operation_Name == 'helpdesk' | project timestamp, message | order by timestamp asc"

#Dev
$env:REQUESTS_CA_BUNDLE = "$env:USERPROFILE\Zscaler Root.cer"
az monitor app-insights query --app b548eeab-d25d-4ef1-982d-7b7fc3c5fad9 -o json --analytics-query `
 "traces | where timestamp > ago(20m) | where cloud_RoleName == 'funcapp-core-helpdesk-dev000' | project timestamp, message | order by timestamp asc"



 Remove-Item env:\REQUESTS_CA_BUNDLE -ErrorAction SilentlyContinue
az account set --subscription 95ed3ea8-d8bc-452c-8ea1-8b2ef682219d
az functionapp config appsettings list -g rg-core-func-spk-helpdesk-dev000 -n funcapp-core-helpdesk-dev000 -o json --query "[?name=='TICKET_CREATE' || name=='MAILBOX_DRAIN' || name=='MAIL_IGNORE_BEFORE']"



$env:REQUESTS_CA_BUNDLE = "$env:USERPROFILE\Zscaler Root.cer"
az monitor app-insights query --app fb576bae-2a09-465f-9130-56a8ac1bbe64 -o json --analytics-query `
  "traces | where timestamp > ago(2h) | where cloud_RoleName == 'funcapp-core-helpdesk-dev000' | where message has 'drain inbox' or message has 'disabled' or message has 'Ticket' or message has 'claim' | project timestamp, message | order by timestamp desc | take 40"



  az monitor app-insights query --app b548eeab-d25d-4ef1-982d-7b7fc3c5fad9  -o json --analytics-query `
  "union traces, requests | where timestamp > ago(2h) | summarize n=count() by cloud_RoleName"



$RelaySubscription   = "da39198a-32a8-469a-917a-c7eb9ea347d4"
$RelayResourceGroup  = "rg-core-data-spk-helpdesk-prod000"
$RelayFunctionApp    = "funcapp-core-helpdesk-prod000"
$RelayStorageAccount = "stcoredatahdrelayeusprd"
$RelayQueue          = "mail-notifications"
az account set --subscription $RelaySubscription
az account show --query "{subscription:name, tenant:tenantId}" -o table




# Prevent active processing, notifications, or the sweep from refilling the queue.
az functionapp stop `
  --resource-group $RelayResourceGroup `
  --name $RelayFunctionApp


# Inspect up to 10 visible messages before deleting anything.
az storage message peek `
  --account-name $RelayStorageAccount `
  --queue-name $RelayQueue `
  --num-messages 10 `
  --auth-mode login `
  -o table


# Irreversibly delete every message while preserving the queue.
az storage message clear `
  --account-name $RelayStorageAccount `
  --queue-name $RelayQueue `
  --auth-mode login


# Verify that no visible messages remain.
az storage message peek `
  --account-name $RelayStorageAccount `
  --queue-name $RelayQueue `
  --num-messages 1 `
  --auth-mode login
az functionapp start `
  --resource-group $RelayResourceGroup `
  --name $RelayFunctionApp


  Azure Queue Storage primary mail queue clear complete




  #Critical Values for GH Prod Push
# verify
gh variable list --env Production -R $Repo
gh variable list --env Development -R $Repo


gh variable set MAIL_IGNORE_BEFORE --env Production --body "2026-08-20T17:15:00Z" -R $Repo   # go-live instant
gh variable set TICKET_CREATE --env Production --body "true" -R $Repo   # go-live instant
gh variable set SUBMITTER_REPLIES --env Production --body "true" -R $Repo   # go-live instant
gh variable set AGENT_NOTICES --env Production --body "true" -R $Repo   # go-live instant
gh variable set FOLLOWERS_NOTICES --env Production --body "true" -R $Repo   # go-live instant
gh variable set MAILBOX_DRAIN --env Production --body "true" -R $Repo   # go-live instant
gh variable set OUTBOUND_INLINE_ATTACHMENT_MAX_BYTES --env Production --body "100000000" -R $Repo   # Outbound file size limits