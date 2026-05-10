export type DiagnosticContentCapturePolicy = {
  inputMessages: boolean;
  outputMessages: boolean;
  toolInputs: boolean;
  toolOutputs: boolean;
  systemPrompt: boolean;
};

const NO_CONTENT_CAPTURE: DiagnosticContentCapturePolicy = {
  inputMessages: false,
  outputMessages: false,
  toolInputs: false,
  toolOutputs: false,
  systemPrompt: false,
};

export function resolveDiagnosticContentCapturePolicy(
  value: unknown,
): DiagnosticContentCapturePolicy {
  if (value === true) {
    return {
      inputMessages: true,
      outputMessages: true,
      toolInputs: true,
      toolOutputs: true,
      systemPrompt: false,
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return NO_CONTENT_CAPTURE;
  }

  const config = value as Record<string, unknown>;
  if (config.enabled !== true) {
    return NO_CONTENT_CAPTURE;
  }
  return {
    inputMessages: config.inputMessages === true,
    outputMessages: config.outputMessages === true,
    toolInputs: config.toolInputs === true,
    toolOutputs: config.toolOutputs === true,
    systemPrompt: config.systemPrompt === true,
  };
}
