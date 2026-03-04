import type { ReactNode, RefObject } from "react";

interface ConversationShellProps {
  taskRail?: ReactNode;
  children: ReactNode;
  composer: ReactNode;
  scrollAnchorRef?: RefObject<HTMLDivElement>;
}

export function ConversationShell({ taskRail, children, composer, scrollAnchorRef }: ConversationShellProps) {
  return (
    <div className="chat-shell">
      {taskRail ? <div className="chat-rail">{taskRail}</div> : null}
      <div className="chat-scroll">
        <div className="chat-stack">{children}</div>
        {scrollAnchorRef ? <div ref={scrollAnchorRef} /> : null}
      </div>
      {composer}
    </div>
  );
}
