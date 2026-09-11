import Image from "next/image";
import type { Prisma } from "@/generated/prisma/client";
import { formatPrice } from "@/lib/format";

type ProductCardProps = {
  name: string;
  description: string | null;
  price: Prisma.Decimal;
  image: string | null;
};

export function ProductCard({ name, description, price, image }: ProductCardProps) {
  return (
    <li className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm">
      {image ? (
        <div className="relative aspect-[4/3] w-full overflow-hidden bg-zinc-100">
          <Image
            src={image}
            alt={name}
            fill
            sizes="(max-width: 430px) 100vw, 448px"
            className="object-cover object-center"
            unoptimized
          />
        </div>
      ) : null}
      <div className="p-4">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="min-w-0 break-words text-base font-semibold leading-snug text-zinc-900">
            {name}
          </h3>
          <p className="shrink-0 whitespace-nowrap text-base font-bold text-zinc-900">
            {formatPrice(price)}
          </p>
        </div>
        {description ? (
          <p className="mt-1 text-sm leading-relaxed text-zinc-600">{description}</p>
        ) : null}
      </div>
    </li>
  );
}