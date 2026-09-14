import { IconLock, IconShieldCheck, IconUser } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { StaggerItem } from "@/components/layout/stagger";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  setPersonAccessMutationOptions,
  setPersonRoleMutationOptions,
} from "@/lib/people/mutations";
import { type Person, peopleListQueryOptions } from "@/lib/people/queries";
import { inviteSectorOwnerMutationOptions } from "@/lib/sectors/mutations";
import { sectorListQueryOptions } from "@/lib/sectors/queries";
import { queryClient } from "@/query-client";
export const Route = createFileRoute("/_authed/admin/people")({
  component: PeoplePage,
});

/** What each provider is called, since the id it registers under is not a name. */
const PROVIDER_NAMES: Record<string, string> = {
  google: "Google",
  microsoft: "Microsoft",
  okta: "Okta",
};

/**
 * The second line of a person's row: how they got here, and when they were last here.
 *
 * The address is the title, so this is everything else worth knowing at a glance while deciding
 * whether somebody should still have access.
 */
function describe(person: Person): string {
  const providers = person.providers
    .map((provider) => PROVIDER_NAMES[provider] ?? provider)
    .join(", ");
  const when = person.lastSignedInAt
    ? `last signed in ${new Date(person.lastSignedInAt).toLocaleDateString()}`
    : "never signed in";

  if (person.revoked) return `Access removed · ${providers || "no provider"}`;
  if (person.configuredAdmin) {
    return `Administrator by configuration · ${when}`;
  }
  return `${providers || "no provider"} · ${when}`;
}

function PeoplePage() {
  const people = useQuery(peopleListQueryOptions());
  const sectors = useQuery(sectorListQueryOptions());
  const currentUser = useQuery(currentUserQueryOptions());
  const setRole = useMutation(setPersonRoleMutationOptions(queryClient));
  const setAccess = useMutation(setPersonAccessMutationOptions(queryClient));
  const invite = useMutation(inviteSectorOwnerMutationOptions(queryClient));
  const [dialogSector, setDialogSector] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");

  const failure = setRole.error ?? setAccess.error ?? invite.error;

  return (
    <PageShell
      description="Todo mundo que já entrou. Administradores alcançam estas telas; o resto conversa com os Bots."
      title="Pessoas"
    >
      <PageSection
        description="Um endereço listado em INITIAL_ADMIN_EMAILS é administrador independente do que esta tela disser, então não dá para mudar aqui."
        title="Quem está aqui"
      >
        {failure ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {failure.message}
          </p>
        ) : null}
        {people.isPending ? null : people.error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            Não foi possível carregar as pessoas.
          </p>
        ) : people.data?.length === 0 ? (
          <PageEmpty>
            Ninguém entrou ainda. As pessoas aparecem aqui assim que entrarem.
          </PageEmpty>
        ) : (
          <PageRows>
            {people.data?.map((person, index) => {
              const isSelf = person.id === currentUser.data?.id;
              const busy = setRole.isPending || setAccess.isPending;

              return (
                <StaggerItem index={index} key={person.id}>
                  <Item size="sm">
                    <ItemMedia variant="icon">
                      {person.revoked ? (
                        <IconLock />
                      ) : person.role === "admin" ? (
                        <IconShieldCheck />
                      ) : (
                        <IconUser />
                      )}
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>{person.name ?? person.email}</ItemTitle>
                      <ItemDescription>
                        {person.name ? `${person.email} · ` : ""}
                        {describe(person)}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      {/*
                       * Removing access is the louder decision, so it is a button rather than a
                       * second switch: two switches on one row invites somebody to flip the wrong
                       * one, and these two do very different things.
                       */}
                      <Button
                        disabled={busy || isSelf || person.configuredAdmin}
                        onClick={() =>
                          setAccess.mutate({
                            userId: person.id,
                            revoked: !person.revoked,
                          })
                        }
                        size="sm"
                        variant={person.revoked ? "outline" : "destructive"}
                      >
                        {person.revoked ? "Restore" : "Remover"}
                      </Button>
                      <Switch
                        aria-label={`Administrator: ${person.email}`}
                        checked={person.role === "admin"}
                        disabled={busy || person.configuredAdmin || isSelf}
                        onCheckedChange={(checked) =>
                          setRole.mutate({
                            userId: person.id,
                            role: checked ? "admin" : "user",
                          })
                        }
                      />
                    </ItemActions>
                  </Item>
                  {index !== (people.data?.length ?? 0) - 1 && <Separator />}
                </StaggerItem>
              );
            })}
          </PageRows>
        )}
      </PageSection>
      <PageSection description="Cada setor tem um responsável com login próprio. O convite vale 72h; o acesso nasce na verificação do email, nunca antes." title="Setores">
        {sectors.isPending ? null : sectors.error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">Não foi possível carregar os setores.</p>
        ) : (
          <PageRows>
            {(sectors.data ?? []).map((sector, index) => (
              <StaggerItem index={index} key={sector.id}>
                <Item size="sm">
                  <ItemContent>
                    <ItemTitle>{sector.name}</ItemTitle>
                    <ItemDescription>
                      {sector.ownerUserId ? "Responsável cadastrado" : "Aguardando cadastro/verificação"}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      disabled={sector.ownerUserId !== null}
                      onClick={() => {
                        setDialogSector(sector.id);
                        setInviteEmail("");
                        setInviteName("");
                      }}
                      size="sm"
                      variant="outline"
                    >
                      Convidar responsável
                    </Button>
                  </ItemActions>
                </Item>
                {index !== (sectors.data?.length ?? 0) - 1 && <Separator />}
              </StaggerItem>
            ))}
          </PageRows>
        )}
      </PageSection>
      <Dialog onOpenChange={(open) => { if (!open) setDialogSector(null); }} open={dialogSector !== null}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Convidar responsável</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Input onChange={(event) => setInviteName(event.target.value)} placeholder="Nome" type="text" value={inviteName} />
            <Input autoComplete="email" onChange={(event) => setInviteEmail(event.target.value)} placeholder="email@empresa.com" type="email" value={inviteEmail} />
          </div>
          <DialogFooter>
            <Button
              disabled={invite.isPending || !inviteEmail.trim() || !inviteName.trim() || !dialogSector}
              onClick={() => {
                if (!dialogSector) return;
                invite.mutate(
                  { sectorId: dialogSector, email: inviteEmail.trim(), name: inviteName.trim() },
                  { onSuccess: () => setDialogSector(null) },
                );
              }}
            >
              Enviar convite
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
