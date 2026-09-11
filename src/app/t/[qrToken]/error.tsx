"use client";

export default function MenuError() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-zinc-50 px-6 py-10">
      <div role="alert" className="mx-auto w-full max-w-md text-center">
        <h1 className="text-lg font-bold leading-snug text-zinc-900">
          Não foi possível carregar o cardápio.
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-zinc-600">
          Tente novamente em instantes.
        </p>
      </div>
    </main>
  );
}