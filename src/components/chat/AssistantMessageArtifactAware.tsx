import { MessagePrimitive, useMessage } from "@assistant-ui/react";
import {
  AssistantActionBar,
  BranchPicker,
  MessagePart,
  useThreadConfig,
} from "@assistant-ui/react-ui";
import { useMemo } from "react";

const THREAD_ARTIFACT_MARKER_PREFIX = "FRICTION_ARTIFACT::";

function hasThreadArtifactMarker(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    if (!part || typeof part !== "object") return false;
    const maybePart = part as { type?: unknown; text?: unknown };
    return (
      maybePart.type === "text" &&
      typeof maybePart.text === "string" &&
      maybePart.text.trim().startsWith(THREAD_ARTIFACT_MARKER_PREFIX)
    );
  });
}

export function AssistantMessageArtifactAware() {
  const isArtifactMessage = useMessage((state) =>
    hasThreadArtifactMarker(state.content),
  );
  const {
    tools,
    assistantAvatar: assistantAvatarConfig = { fallback: "A" },
    assistantMessage: { components = {} } = {},
  } = useThreadConfig();

  const avatarFallback =
    typeof assistantAvatarConfig.fallback === "string" &&
    assistantAvatarConfig.fallback.trim()
      ? assistantAvatarConfig.fallback
      : "A";

  const toolComponents = useMemo(
    () => ({
      by_name: !tools
        ? undefined
        : Object.fromEntries(
            tools.map((tool) => [tool.unstable_tool.toolName, tool.unstable_tool.render]),
          ),
      Fallback: components.ToolFallback,
    }),
    [tools, components.ToolFallback],
  );

  const Footer = components.Footer;

  return (
    <MessagePrimitive.Root
      className="aui-assistant-message-root"
      data-friction-artifact={isArtifactMessage ? "true" : "false"}
    >
      <span className="aui-avatar-root">
        <span className="aui-avatar-fallback">{avatarFallback}</span>
      </span>
      <div className="aui-assistant-message-content">
        <MessagePrimitive.Content
          components={{
            Text: components.Text ?? MessagePart.Text,
            Empty: components.Empty,
            tools: toolComponents,
          }}
        />
        {Footer ? <Footer /> : null}
      </div>
      {isArtifactMessage ? null : <BranchPicker />}
      {isArtifactMessage ? null : <AssistantActionBar />}
    </MessagePrimitive.Root>
  );
}
