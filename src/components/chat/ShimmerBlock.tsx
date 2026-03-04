interface ShimmerBlockProps {
  lines?: number;
}

export function ShimmerBlock({ lines = 3 }: ShimmerBlockProps) {
  return (
    <div className="chat-shimmer" aria-hidden="true">
      {Array.from({ length: lines }).map((_, index) => (
        <div
          key={index}
          className="h-3 animate-pulse rounded bg-friction-surface-alt"
          style={{ width: `${Math.max(55, 100 - index * 15)}%` }}
        />
      ))}
    </div>
  );
}
