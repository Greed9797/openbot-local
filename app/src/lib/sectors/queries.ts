import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

export type Sector = {
  id: string;
  name: string;
  ownerUserId: string | null;
  lastDispatchedAt: string | null;
};

export const sectorKeys = {
  all: ["sectors"] as const,
  list: () => ["sectors", "list"] as const,
};

export function sectorListQueryOptions() {
  return queryOptions({
    queryKey: sectorKeys.list(),
    queryFn: (): Promise<Sector[]> =>
      client("/api/admin/sectors", "sectors", {
        fallback: "Não foi possível carregar os setores",
      }),
  });
}
