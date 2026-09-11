export default function MenuLoading() {
  return (
    <main className="bg-zinc-50">
      <p className="sr-only">Carregando o cardápio...</p>
      <div className="h-40 animate-pulse rounded-b-3xl bg-zinc-200" aria-hidden="true" />
      <section className="mx-auto w-full max-w-md space-y-8 px-4 pt-6 pb-12" aria-hidden="true">
        <div className="h-5 w-40 animate-pulse rounded bg-zinc-200" />
        <div className="h-28 animate-pulse rounded-2xl bg-zinc-100" />
        <div className="h-28 animate-pulse rounded-2xl bg-zinc-100" />
        <div className="h-28 animate-pulse rounded-2xl bg-zinc-100" />
      </section>
    </main>
  );
}