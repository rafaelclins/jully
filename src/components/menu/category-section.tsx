import type { ActiveMenuCategory } from "@/services/menus";
import { ProductCard } from "@/components/menu/product-card";

type CategorySectionProps = {
  id: string;
  name: string;
  currency: string;
  products: ActiveMenuCategory["products"];
};

export function CategorySection({
  id,
  name,
  currency,
  products,
}: CategorySectionProps) {
  return (
    <section aria-labelledby={`category-${id}`}>
      <h2
        id={`category-${id}`}
        className="text-lg font-bold tracking-tight text-zinc-900"
      >
        {name}
      </h2>
      {products.length > 0 ? (
        <ul className="mt-3 space-y-3">
          {products.map((product) => (
            <ProductCard
              key={product.id}
              productId={product.id}
              name={product.name}
              description={product.description}
              price={product.price}
              image={product.image}
              currency={currency}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}