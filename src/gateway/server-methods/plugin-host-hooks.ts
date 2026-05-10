import { getActivePluginRegistry } from "../../plugins/runtime.js";
import { ADMIN_SCOPE, READ_SCOPE, WRITE_SCOPE, type OperatorScope } from "../operator-scopes.js";
import { issuePluginUiEntryPointLaunchPath } from "../plugin-ui-entry-launch-tokens.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validatePluginsUiDescriptorsParams,
  validatePluginsUiEntryPointLaunchParams,
  validatePluginsUiEntryPointsParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

function hasRequiredScope(callerScopes: readonly string[], requiredScope: OperatorScope): boolean {
  if (callerScopes.includes(ADMIN_SCOPE)) {
    return true;
  }
  if (requiredScope === READ_SCOPE) {
    return callerScopes.includes(READ_SCOPE) || callerScopes.includes(WRITE_SCOPE);
  }
  return callerScopes.includes(requiredScope);
}

export const pluginHostHookHandlers: GatewayRequestHandlers = {
  "plugins.uiDescriptors": ({ params, respond }) => {
    if (!validatePluginsUiDescriptorsParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid plugins.uiDescriptors params: ${formatValidationErrors(validatePluginsUiDescriptorsParams.errors)}`,
        ),
      );
      return;
    }
    const descriptors = (getActivePluginRegistry()?.controlUiDescriptors ?? []).map((entry) =>
      Object.assign({}, entry.descriptor, {
        pluginId: entry.pluginId,
        pluginName: entry.pluginName,
      }),
    );
    respond(true, { ok: true, descriptors }, undefined);
  },
  "plugins.uiEntryPoints": ({ client, params, respond }) => {
    if (!validatePluginsUiEntryPointsParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid plugins.uiEntryPoints params: ${formatValidationErrors(validatePluginsUiEntryPointsParams.errors)}`,
        ),
      );
      return;
    }
    const callerScopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
    const entryPoints = (getActivePluginRegistry()?.controlUiEntryPoints ?? [])
      .filter((entry) =>
        (entry.entryPoint.requiredScopes ?? []).every((scope) =>
          hasRequiredScope(callerScopes, scope),
        ),
      )
      .map((entry) =>
        Object.assign({}, entry.entryPoint, {
          pluginId: entry.pluginId,
          pluginName: entry.pluginName,
        }),
      );
    respond(true, { ok: true, entryPoints }, undefined);
  },
  "plugins.uiEntryPointLaunch": ({ client, params, respond }) => {
    if (!validatePluginsUiEntryPointLaunchParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid plugins.uiEntryPointLaunch params: ${formatValidationErrors(validatePluginsUiEntryPointLaunchParams.errors)}`,
        ),
      );
      return;
    }
    const callerScopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
    const registryEntry = (getActivePluginRegistry()?.controlUiEntryPoints ?? []).find(
      (entry) =>
        entry.pluginId === params.pluginId &&
        entry.entryPoint.id === params.id &&
        entry.entryPoint.path === params.path,
    );
    if (
      !registryEntry ||
      !(registryEntry.entryPoint.requiredScopes ?? []).every((scope) =>
        hasRequiredScope(callerScopes, scope),
      )
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "plugin UI entry point is not available"),
      );
      return;
    }
    const path = issuePluginUiEntryPointLaunchPath({
      path: registryEntry.entryPoint.path,
      scopes: callerScopes,
      sessionKey: typeof params.sessionKey === "string" ? params.sessionKey.trim() : undefined,
      contextTokens:
        typeof params.contextTokens === "number" && Number.isFinite(params.contextTokens)
          ? Math.floor(params.contextTokens)
          : undefined,
    });
    respond(true, { ok: true, path, expiresInMs: 60_000 }, undefined);
  },
};
