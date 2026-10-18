interface Props {
  text: string | null;
}

/** A small comic speech bubble pinned above the sprite. Click-through. */
export function SpeechBubble({ text }: Props) {
  if (!text) return null;
  return (
    <div className="speech-bubble">
      {text}
      <span className="speech-tail" />
    </div>
  );
}
