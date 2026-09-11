import Image from "next/image";
import { resolveBrandColors } from "@/lib/menu-colors";

type RestaurantHeaderProps = {
  name: string;
  logo: string | null;
  primaryColor: string | null;
  secondaryColor: string | null;
  tableNumber: number;
};

export function RestaurantHeader({
  name,
  logo,
  primaryColor,
  secondaryColor,
  tableNumber,
}: RestaurantHeaderProps) {
  const { primary, secondary, onPrimary } = resolveBrandColors(
    primaryColor,
    secondaryColor
  );

  const initial =
    name
      .trim()
      .charAt(0)
      .toUpperCase() || "?";

  return (
    <header
      className="px-5 pb-7 pt-10"
      style={{
        backgroundImage: `linear-gradient(165deg, ${primary}, ${secondary})`,
      }}
    >
      <div className="flex items-center gap-4">
        {logo ? (
          <Image
            src={logo}
            alt={`Logo do ${name}`}
            width={64}
            height={64}
            className="h-16 w-16 shrink-0 rounded-2xl object-cover ring-2 ring-white/40"
            unoptimized
          />
        ) : (
          <span
            aria-hidden="true"
            className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl text-2xl font-bold ring-2 ring-white/40"
            style={{
              backgroundColor: "rgba(255, 255, 255, 0.16)",
              color: onPrimary,
            }}
          >
            {initial}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <h1
            className="break-words text-2xl font-bold leading-tight tracking-tight"
            style={{ color: onPrimary }}
          >
            {name}
          </h1>
          <p
            className="mt-2 inline-flex items-center rounded-full px-3 py-1 text-sm font-semibold"
            style={{
              backgroundColor: "rgba(255, 255, 255, 0.2)",
              color: onPrimary,
            }}
          >
            Mesa {tableNumber}
          </p>
        </div>
      </div>
    </header>
  );
}