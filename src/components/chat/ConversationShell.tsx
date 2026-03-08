import type { ReactNode, RefObject } from "react";

interface ConversationShellProps {
  children: ReactNode;
  composer: ReactNode;
  scrollAnchorRef?: RefObject<HTMLDivElement>;
}

export function ConversationShell({ children, composer, scrollAnchorRef }: ConversationShellProps) {
  return (
    <div className="chat-shell">
      <div className="chat-scroll">
        <div className="chat-stack">{children}</div>
        {scrollAnchorRef ? <div ref={scrollAnchorRef} /> : null}
      </div>
      {composer}
    </div>
  );
}
