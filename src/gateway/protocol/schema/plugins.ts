import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

export const PluginJsonValueSchema = Type.Unknown();

export const PluginControlUiDescriptorSchema = Type.Object(
  {
    id: NonEmptyString,
    pluginId: NonEmptyString,
    pluginName: Type.Optional(NonEmptyString),
    surface: Type.Union([
      Type.Literal("session"),
      Type.Literal("tool"),
      Type.Literal("run"),
      Type.Literal("settings"),
    ]),
    label: NonEmptyString,
    description: Type.Optional(Type.String()),
    placement: Type.Optional(Type.String()),
    schema: Type.Optional(PluginJsonValueSchema),
    requiredScopes: Type.Optional(Type.Array(NonEmptyString)),
  },
  { additionalProperties: false },
);

export const PluginsUiDescriptorsParamsSchema = Type.Object({}, { additionalProperties: false });

export const PluginsUiDescriptorsResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    descriptors: Type.Array(PluginControlUiDescriptorSchema),
  },
  { additionalProperties: false },
);

export const PluginControlUiEntryPointSchema = Type.Object(
  {
    id: NonEmptyString,
    pluginId: NonEmptyString,
    pluginName: Type.Optional(NonEmptyString),
    surface: Type.Literal("app-nav"),
    label: NonEmptyString,
    path: NonEmptyString,
    openMode: Type.Optional(
      Type.Union([Type.Literal("in-app"), Type.Literal("same-window"), Type.Literal("new-window")]),
    ),
    description: Type.Optional(Type.String()),
    requiredScopes: Type.Optional(Type.Array(NonEmptyString)),
  },
  { additionalProperties: false },
);

export const PluginsUiEntryPointsParamsSchema = Type.Object({}, { additionalProperties: false });

export const PluginsUiEntryPointsResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    entryPoints: Type.Array(PluginControlUiEntryPointSchema),
  },
  { additionalProperties: false },
);

export const PluginsUiEntryPointLaunchParamsSchema = Type.Object(
  {
    id: NonEmptyString,
    pluginId: NonEmptyString,
    path: NonEmptyString,
    sessionKey: Type.Optional(NonEmptyString),
    contextTokens: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

export const PluginsUiEntryPointLaunchResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    path: NonEmptyString,
    expiresInMs: Type.Number(),
  },
  { additionalProperties: false },
);
