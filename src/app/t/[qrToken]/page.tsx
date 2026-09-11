import { CartBar } from "@/components/cart/cart-bar";
import { CartProvider } from "@/components/cart/cart-provider";
import { CartView } from "@/components/cart/cart-view";
import { CategorySection } from "@/components/menu/category-section";
import { RestaurantHeader } from "@/components/menu/restaurant-header";
import { StatusMessage } from "@/components/menu/status-message";
import { getActiveMenuByRestaurantId } from "@/services/menus";
import { getTableByQrToken } from "@/services/tables";

export const dynamic = "force-dynamic";

const QR_TOKEN_PATTERN = /^[a-zA-Z0-9_-]{1,120}$/;

type PublicMenuPageProps = {
  params: Promise<{ qrToken: string }>;
};

function CenteredStatus({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-zinc-50 px-6 py-10">
      <StatusMessage title={title} description={description} />
    </main>
  );
}

export default async function PublicMenuPage({ params }: PublicMenuPageProps) {
  const { qrToken } = await params;

  if (!QR_TOKEN_PATTERN.test(qrToken)) {
    return (
      <CenteredStatus
        title="Este QR Code não é válido."
        description="Escaneie novamente o código impresso na mesa."
      />
    );
  }

  let table: Awaited<ReturnType<typeof getTableByQrToken>>;
  try {
    table = await getTableByQrToken(qrToken);
  } catch {
    return (
      <CenteredStatus
        title="Não foi possível carregar o cardápio."
        description="Tente novamente em instantes."
      />
    );
  }

  if (!table) {
    return (
      <CenteredStatus
        title="Este QR Code não é válido."
        description="Escaneie novamente o código impresso na mesa."
      />
    );
  }

  const restaurant = table.restaurant;

  const header = (
    <RestaurantHeader
      name={restaurant.name}
      logo={restaurant.logo}
      primaryColor={restaurant.primaryColor}
      secondaryColor={restaurant.secondaryColor}
      tableNumber={table.number}
    />
  );

  if (!table.active) {
    return (
      <main className="min-h-dvh bg-zinc-50">
        {header}
        <section className="px-6 pt-8 pb-12">
          <CenteredStatus
            title="Esta mesa não está disponível no momento."
            description="Converse com uma pessoa do atendimento para ajudar você."
          />
        </section>
      </main>
    );
  }

  let categories: Awaited<ReturnType<typeof getActiveMenuByRestaurantId>>;
  try {
    categories = await getActiveMenuByRestaurantId(restaurant.id);
  } catch {
    return (
      <CenteredStatus
        title="Não foi possível carregar o cardápio."
        description="Tente novamente em instantes."
      />
    );
  }

  const visibleCategories = categories.filter(
    (category) => category.products.length > 0
  );

  return (
    <CartProvider contextId={qrToken}>
      <main className="min-h-dvh bg-zinc-50">
        {header}
        {visibleCategories.length === 0 ? (
          <section className="px-6 pt-8 pb-12">
            <CenteredStatus
              title="O cardápio ainda não possui itens disponíveis."
              description="Em breve, novidades por aqui."
            />
          </section>
        ) : (
          <section
            aria-label="Cardápio"
            className="mx-auto w-full max-w-md space-y-8 px-4 pt-6 pb-32"
          >
            {visibleCategories.map((category) => (
              <CategorySection
                key={category.id}
                id={category.id}
                name={category.name}
                products={category.products}
              />
            ))}
          </section>
        )}
        <CartBar />
        <CartView />
      </main>
    </CartProvider>
  );
}