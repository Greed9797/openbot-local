import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { sectorKeys } from "./queries";

const FALLBACK = "Não foi possível convidar";

export function inviteSectorOwnerMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: { sectorId: string; email: string; name: string }) =>
      client(`/api/admin/sectors/${variables.sectorId}/enrollment`, "enrollment", {
        method: "POST",
        body: { email: variables.email, name: variables.name },
        fallback: FALLBACK,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: sectorKeys.all }),
  });
}

export function resendSectorInviteMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: { sectorId: string; email: string }) =>
      client(
        `/api/admin/sectors/${variables.sectorId}/enrollment/resend`,
        "enrollment",
        {
          method: "POST",
          body: { email: variables.email },
          fallback: FALLBACK,
        },
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: sectorKeys.all }),
  });
}
