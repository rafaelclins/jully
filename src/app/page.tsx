import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { listMembershipRestaurantsForUser } from "@/services/memberships";

export const dynamic = "force-dynamic";

export default async function Home() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    redirect("/login");
  }

  const memberships = await listMembershipRestaurantsForUser(session.user.id);
  if (memberships.length === 1) {
    redirect(`/restaurant/${memberships[0].restaurant.slug}/orders`);
  }

  return (
    <div className="min-h-screen bg-zinc-50 px-4 py-8 text-zinc-950">
      <main className="mx-auto flex w-full max-w-2xl flex-col gap-6">
        <header>
          <p className="text-sm font-medium text-zinc-500">JULLY</p>
          <h1 className="mt-2 text-2xl font-semibold">Selecionar restaurante</h1>
        </header>

        {memberships.length === 0 ? (
          <section className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
            <h2 className="text-base font-semibold">Nenhum restaurante disponível</h2>
            <p className="mt-2 text-sm text-zinc-600">
              Sua conta ainda não tem acesso operacional.
            </p>
          </section>
        ) : (
          <section className="grid gap-3">
            {memberships.map((membership) => (
              <Link
                key={membership.restaurant.id}
                href={`/restaurant/${membership.restaurant.slug}/orders`}
                className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm transition hover:border-zinc-300 hover:bg-zinc-50"
              >
                <div className="font-semibold">{membership.restaurant.name}</div>
                <div className="mt-1 text-sm text-zinc-500">
                  {membership.role} · /{membership.restaurant.slug}
                </div>
              </Link>
            ))}
          </section>
        )}
      </main>
    </div>
  );
}
