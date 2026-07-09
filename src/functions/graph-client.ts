// src/functions/graph-client.ts
// Shared app-only Microsoft Graph client. Promoted out of sharepoint.ts so the mail
// (read/send) and SharePoint (upload) paths share one credential + axios factory.
//
// Auth model (secretless): the Graph **app registration** federate-trusts the Function App's
// **user-assigned managed identity** (a Federated Identity Credential). The MI mints a token
// for `api://AzureADTokenExchange`, which is exchanged for a Graph token AS the app
// registration — no client secret anywhere. The MI also resolves the Key Vault references for
// the relay's non-Entra secrets (HELPDESK_PAT, GRAPH_SUBSCRIPTION_CLIENT_STATE).
import axios, { AxiosInstance } from "axios";
import {
  DefaultAzureCredential,
  ClientAssertionCredential,
  ManagedIdentityCredential,
  TokenCredential,
} from "@azure/identity";
import { attachRetryInterceptor } from "./http-retry";
import { envPositiveNumber } from "./env";

// #region Public Types

export type GraphAuthConfig = {
  graphBaseUrl: string; // e.g. https://graph.microsoft.com/v1.0
  // App-registration identity (the Graph principal); the UAMI federates it (FIC) — no secret.
  tenantId?: string;
  clientId?: string;
  // User-assigned managed identity client id (omit for a system-assigned identity).
  managedIdentityClientId?: string;
};

// #endregion

const DEFAULT_GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";

// Per-request timeout for normal Graph calls (reads, sendMail, folder ops, move). Bounding this
// stops a single hung call from burning the whole 10-min function invocation; the retry
// interceptor then turns a transient failure into a fast retry instead of a dead invocation.
export const GRAPH_REQUEST_TIMEOUT_MS = envPositiveNumber(process.env.GRAPH_HTTP_TIMEOUT_MS, 60_000);
// Attachment transfers (whole-file download + the large content PUT) are legitimately slow, so
// they override the default with a much longer per-request budget (still under functionTimeout).
export const GRAPH_TRANSFER_TIMEOUT_MS = envPositiveNumber(process.env.GRAPH_TRANSFER_TIMEOUT_MS, 300_000);

/**
 * Read Graph auth/config from the environment.
 * The app registration is the Graph principal (`GRAPH_TENANT_ID`/`GRAPH_CLIENT_ID`, legacy
 * `SPO_*` accepted); `MANAGED_IDENTITY_CLIENT_ID` selects the user-assigned MI that federates
 * it. No client secret is read — auth is secretless.
 */
export function graphConfigFromEnv(): GraphAuthConfig {
  return {
    graphBaseUrl: process.env.GRAPH_BASE_URL ?? DEFAULT_GRAPH_BASE_URL,
    tenantId: process.env.GRAPH_TENANT_ID ?? process.env.SPO_TENANT_ID,
    clientId: process.env.GRAPH_CLIENT_ID ?? process.env.SPO_CLIENT_ID,
    managedIdentityClientId: process.env.MANAGED_IDENTITY_CLIENT_ID,
  };
}

/**
 * Create an Axios Graph client authorized with an app-only bearer token.
 */
export async function createGraphClient(
  config: GraphAuthConfig,
  log?: (...args: any[]) => void
): Promise<AxiosInstance> {
  const token = await getGraphToken(config, log);
  const client = axios.create({
    baseURL: config.graphBaseUrl,
    timeout: GRAPH_REQUEST_TIMEOUT_MS,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  return attachRetryInterceptor(client);
}

/**
 * Convenience wrapper: build a Graph client from the ambient environment. Used by the function
 * handlers (process-mail, helpdesk, renew-subscriptions) so they don't each repeat
 * `createGraphClient(graphConfigFromEnv())`.
 */
export async function createGraphClientFromEnv(
  log?: (...args: any[]) => void
): Promise<AxiosInstance> {
  return createGraphClient(graphConfigFromEnv(), log);
}

/**
 * Acquire an app-only token for Microsoft Graph. See getCredential for the selection order.
 */
export async function getGraphToken(
  config: GraphAuthConfig,
  log?: (...args: any[]) => void
): Promise<string> {
  log?.("Auth: token acquisition starting", {
    using: describeCredential(config),
  });

  const cred = getCredential(config);
  const scope = "https://graph.microsoft.com/.default";
  const token = await cred.getToken(scope);
  if (!token?.token) throw new Error("Failed to acquire Graph token");
  return token.token;
}

/**
 * Choose a credential implementation (in order):
 * 1. App-registration federation — the app reg trusts the user-assigned MI (FIC). The MI mints
 *    a token for `api://AzureADTokenExchange`, exchanged for a Graph token as the app reg. The
 *    production path; no secret.
 * 2. Plain managed identity / developer credential (system-assigned MI, or local az login).
 */
function getCredential(config: GraphAuthConfig): TokenCredential {
  if (config.tenantId && config.clientId && config.managedIdentityClientId) {
    const mi = new ManagedIdentityCredential({ clientId: config.managedIdentityClientId });
    return new ClientAssertionCredential(config.tenantId, config.clientId, async () => {
      const t = await mi.getToken("api://AzureADTokenExchange/.default");
      if (!t?.token) {
        throw new Error("Failed to acquire managed-identity token for app-registration federation");
      }
      return t.token;
    });
  }

  return new DefaultAzureCredential(
    config.managedIdentityClientId
      ? { managedIdentityClientId: config.managedIdentityClientId }
      : undefined
  );
}

/**
 * Human-readable description of the credential path (for logs).
 */
function describeCredential(config: GraphAuthConfig): string {
  if (config.tenantId && config.clientId && config.managedIdentityClientId) {
    return "ClientAssertionCredential (app-reg via UAMI federation)";
  }
  return "DefaultAzureCredential (managed identity)";
}
