type HeadingLevel = 1 | 2;

type StatusMessageProps = {
  title: string;
  description?: string;
  headingLevel?: HeadingLevel;
};

export function StatusMessage({
  title,
  description,
  headingLevel = 1,
}: StatusMessageProps) {
  const HeadingTag = headingLevel === 1 ? "h1" : "h2";
  return (
    <div role="status" className="mx-auto w-full max-w-md text-center">
      <HeadingTag className="text-lg font-bold leading-snug text-zinc-900">
        {title}
      </HeadingTag>
      {description ? (
        <p className="mt-2 text-sm leading-relaxed text-zinc-600">{description}</p>
      ) : null}
    </div>
  );
}