interface SuggestionChipsProps {
  suggestions: string[];
  onPick: (text: string) => void;
}

export function SuggestionChips({ suggestions, onPick }: SuggestionChipsProps) {
  if (suggestions.length === 0) return null;

  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {suggestions.map((item) => (
        <button
          key={item}
          type="button"
          className="chat-chip"
          onClick={() => onPick(item)}
        >
          {item}
        </button>
      ))}
    </div>
  );
}
